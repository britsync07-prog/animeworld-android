package com.animeworld

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.regex.Matcher
import java.util.regex.Pattern

class Server(private val context: Context) {
    private var serverSocket: ServerSocket? = null
    private val port = 8080
    private var acceptThread: Thread? = null
    @Volatile private var running = false

    private data class CacheEntry(val timestamp: Long, val data: ByteArray, val ctype: String)

    private val hlsCache = ConcurrentHashMap<String, CacheEntry>()
    private val HLS_CACHE_TTL = 120L
    private val HLS_ALLOWED = Pattern.compile("^(?:play\\.zephyrix\\.org|s\\d+\\.zn-grid\\d+\\.top|zn-grid\\d+\\.top)$")
    private val executor = Executors.newCachedThreadPool()

    sealed class Response {
        data class JsonObject(val json: JSONObject) : Response()
        data class JsonArray(val json: JSONArray) : Response()
        data class Error(val msg: String, val code: Int = 400) : Response()
    }

    fun start() {
        if (running) return
        running = true
        serverSocket = ServerSocket()
        serverSocket?.bind(InetSocketAddress("0.0.0.0", port), 50)
        acceptThread = Thread {
            while (running && !serverSocket?.isClosed!!) {
                try {
                    val client = serverSocket?.accept() ?: break
                    executor.execute { handleClient(client) }
                } catch (e: Exception) {
                    if (running) e.printStackTrace()
                }
            }
        }.also { it.isDaemon = true; it.start() }
    }

    fun stop() {
        running = false
        try { serverSocket?.close() } catch (_: Exception) {}
        try { acceptThread?.join(500) } catch (_: Exception) {}
        executor.shutdownNow()
    }

    private fun handleClient(client: java.net.Socket) {
        client.soTimeout = 30000
        val `in` = BufferedInputStream(client.getInputStream())
        val out = client.getOutputStream()
        try {
            val req = readRequest(`in`) ?: run { writeHttp(out, 400, "text/plain", "Bad Request".toByteArray()); return }
            val path = req.path
            val method = req.method
            val query = req.query

            if (method.equals("OPTIONS", ignoreCase = true)) {
                writeCors(out, 204)
                return
            }
            if (path == "/api/v1/hls" || path == "/api/v1/hls.m3u8") {
                handleHls(out, query)
                return
            }
            if (path.startsWith("/api/v1/")) {
                handleApi(out, path, query)
                return
            }
            if (method == "GET") {
                serveStatic(out, path)
                return
            }
            writeHttp(out, 405, "text/plain", "Method Not Allowed".toByteArray())
        } catch (e: Exception) {
            e.printStackTrace()
            writeHttp(out, 502, "text/plain", ("${e.javaClass.simpleName}: ${e.message}").toByteArray())
        } finally {
            try { out.flush() } catch (_: Exception) {}
            try { client.close() } catch (_: Exception) {}
        }
    }

    private data class Req(val method: String, val path: String, val query: String?)

    private fun readRequest(`in`: InputStream): Req? {
        val reader = BufferedReader(InputStreamReader(`in`, Charsets.ISO_8859_1))
        val requestLine = reader.readLine() ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val method = parts[0]
        val fullPath = parts[1]
        val idx = fullPath.indexOf("?")
        val path = if (idx >= 0) fullPath.substring(0, idx) else fullPath
        val query = if (idx >= 0) fullPath.substring(idx + 1) else null
        // consume headers
        var line: String
        while (reader.readLine().also { line = it } != null && line.isNotEmpty()) {
            // ignore
        }
        return Req(method, path, query)
    }

    private fun serveStatic(out: OutputStream, reqPath: String) {
        val assetPath = if (reqPath == "/" || reqPath.isEmpty()) "www/index.html" else "www$reqPath"
        val sanitized = sanitizeAssetPath(assetPath)
        try {
            context.assets.open(sanitized).use { input ->
                val data = input.readBytes()
                writeHttp(out, 200, guessContentType(reqPath), data, mapOf("Cache-Control" to "no-store"))
            }
        } catch (e: Exception) {
            try {
                context.assets.open("www/index.html").use { input ->
                    val data = input.readBytes()
                    writeHttp(out, 200, "text/html", data, mapOf("Cache-Control" to "no-store"))
                }
            } catch (e2: Exception) {
                writeHttp(out, 404, "text/plain", "Not Found".toByteArray())
            }
        }
    }

    private fun handleApi(out: OutputStream, path: String, query: String?) {
        try {
            when (val resp = apiRoute(path, query)) {
                is Response.JsonObject -> writeJson(out, 200, resp.json)
                is Response.JsonArray -> writeJsonArray(out, 200, resp.json)
                is Response.Error -> writeJson(out, resp.code, JSONObject().put("error", resp.msg))
            }
        } catch (e: Exception) {
            writeJson(out, 502, JSONObject().put("error", "${e.javaClass.simpleName}: ${e.message}"))
        }
    }

    private fun handleHls(out: OutputStream, query: String?) {
        val target = queryParam(query, "url", "") ?: ""
        if (target.isEmpty()) {
            writeJson(out, 400, JSONObject().put("error", "missing ?url="))
            return
        }
        if (!hlsAllowed(target)) {
            writeJson(out, 403, JSONObject().put("error", "host not allowed"))
            return
        }
        val now = System.currentTimeMillis() / 1000
        val cached = hlsCache[target]
        if (cached != null && now - cached.timestamp < HLS_CACHE_TTL) {
            writeHttp(out, 200, cached.ctype, cached.data)
            return
        }
        try {
            val raw = hlsFetch(target)
            val text = raw.toString(Charsets.UTF_8)
            if (text.trimStart().startsWith("#EXTM3U")) {
                val audioSel = queryParam(query, "audio", "")
                val outText = if (!audioSel.isNullOrEmpty()) filterMaster(text, audioSel) else text
                val rewritten = rewritePlaylist(outText, target)
                val ctype = "application/vnd.apple.mpegurl; charset=utf-8"
                hlsCache[target] = CacheEntry(now, rewritten.toByteArray(Charsets.UTF_8), ctype)
                writeHttp(out, 200, ctype, rewritten.toByteArray(Charsets.UTF_8))
            } else {
                val ctype = guessSegCtype(target)
                writeHttp(out, 200, ctype, raw)
            }
        } catch (e: Exception) {
            writeJson(out, 502, JSONObject().put("error", "${e.javaClass.simpleName}: ${e.message}"))
        }
    }

    private fun apiRoute(path: String, query: String?): Response {
        return when (path) {
            "/api/v1/health" -> Response.JsonObject(JSONObject().apply {
                put("status", "ok")
                put("site", AnimeClient.SITE)
                put("player", AnimeClient.PLAYER)
            })
            "/api/v1/search" -> {
                val q = queryParam(query, "q", "") ?: ""
                if (q.isEmpty()) return Response.Error("missing ?q=")
                val limit = queryParam(query, "limit", "20")?.toIntOrNull() ?: 20
                val results = AnimeClient.search(q, limit)
                val arr = JSONArray()
                results.forEach { arr.put(JSONObject(it)) }
                Response.JsonObject(JSONObject().apply { put("results", arr) })
            }
            "/api/v1/feed" -> {
                val kind = queryParam(query, "type", "newest") ?: "newest"
                val category = queryParam(query, "category", "all") ?: "all"
                val page = queryParam(query, "page", "1")?.toIntOrNull() ?: 1
                val limit = queryParam(query, "limit", "25")?.toIntOrNull() ?: 25
                val results = AnimeClient.feed(kind, category, page, limit)
                val arr = JSONArray()
                results.forEach { arr.put(JSONObject(it)) }
                Response.JsonObject(JSONObject().apply { put("items", arr) })
            }
            "/api/v1/categories" -> {
                val perPage = queryParam(query, "per_page", "100")?.toIntOrNull() ?: 100
                val cats = AnimeClient.categories(perPage)
                val arr = JSONArray()
                cats.forEach { arr.put(JSONObject(it)) }
                Response.JsonObject(JSONObject().apply { put("genres", arr) })
            }
            "/api/v1/series" -> {
                val slug = queryParam(query, "slug", "") ?: ""
                if (slug.isEmpty()) return Response.Error("missing ?slug=")
                val s = AnimeClient.series(slug)
                val json = JSONObject().apply {
                    put("slug", slug)
                    put("title", s["title"])
                    put("post_id", s["post_id"])
                    val seasonsArr = JSONArray()
                    (s["seasons"] as List<Int>).forEach { seasonsArr.put(it) }
                    put("seasons", seasonsArr)
                }
                Response.JsonObject(json)
            }
            "/api/v1/seasons" -> {
                val slug = queryParam(query, "slug", "") ?: ""
                if (slug.isEmpty()) return Response.Error("missing ?slug=")
                val s = AnimeClient.series(slug)
                val postId = s["post_id"] as? String ?: return Response.Error("series not found", 404)
                val seasonsList = s["seasons"] as List<Int>
                val seasonsMap = AnimeClient.allSeasons(postId, seasonsList)
                val json = JSONObject().apply {
                    put("slug", slug)
                    put("title", s["title"])
                    val seasonsObj = JSONObject()
                    seasonsMap.forEach { (season, eps) ->
                        val arr = JSONArray()
                        eps.forEach { arr.put(JSONObject(it)) }
                        seasonsObj.put(season.toString(), arr)
                    }
                    put("seasons", seasonsObj)
                }
                Response.JsonObject(json)
            }
            "/api/v1/episodes" -> {
                val slug = queryParam(query, "slug", "")
                val season = queryParam(query, "season", null)
                if (slug.isNullOrEmpty() || season == null) return Response.Error("missing ?slug= and ?season=")
                val s = AnimeClient.series(slug)
                val postId = s["post_id"] as? String ?: return Response.Error("series not found", 404)
                val eps = AnimeClient.episodes(postId, season.toInt())
                val arr = JSONArray()
                eps.forEach { arr.put(JSONObject(it)) }
                Response.JsonArray(arr)
            }
            "/api/v1/stream" -> {
                val slug = queryParam(query, "slug", "")
                val url = queryParam(query, "url", "") ?: ""
                var streamUrl = url
                val series = queryParam(query, "series", "")
                val season = queryParam(query, "season", null)
                val episode = queryParam(query, "episode", null)
                if (!series.isNullOrEmpty() && !season.isNullOrEmpty() && !episode.isNullOrEmpty()) {
                    val s = AnimeClient.series(series)
                    val postId = s["post_id"] as? String ?: return Response.Error("series not found", 404)
                    val eps = AnimeClient.episodes(postId, season.toInt())
                    val hit = eps.firstOrNull { (it["episode"] as Int) == episode.toInt() }
                    if (hit == null) return Response.Error("episode not found", 404)
                    streamUrl = hit["url"] as String
                } else if (!slug.isNullOrEmpty()) {
                    streamUrl = "${AnimeClient.SITE}/episode/$slug/"
                }
                if (streamUrl.isEmpty()) return Response.Error("need ?slug= or ?url= or ?series=&season=&episode=")
                val result = AnimeClient.episodeStream(episodeUrl = streamUrl)
                Response.JsonObject(JSONObject(result))
            }
            "/api/v1/ext_url" -> {
                val raw = queryParam(query, "url", "") ?: ""
                if (raw.isEmpty()) return Response.Error("missing ?url=", 400)
                if (!hlsAllowed(raw)) return Response.Error("host not allowed", 403)
                val base = "http://${lanIp()}:$port/api/v1/hls.m3u8?url="
                var url = base + URLEncoder.encode(raw, "UTF-8")
                val audioSel = queryParam(query, "audio", "")
                if (!audioSel.isNullOrEmpty()) {
                    url += "&audio=" + URLEncoder.encode(audioSel, "UTF-8")
                }
                Response.JsonObject(JSONObject().put("url", url))
            }
            "/api/v1/tracks" -> {
                val raw = queryParam(query, "url", "") ?: ""
                if (raw.isEmpty()) return Response.Error("missing ?url=", 400)
                if (!hlsAllowed(raw)) return Response.Error("host not allowed", 403)
                try {
                    tracks(raw)
                } catch (e: Exception) {
                    Response.Error("${e.javaClass.simpleName}: ${e.message}", 502)
                }
            }
            else -> Response.Error("unknown route: $path", 404)
        }
    }

    private fun tracks(raw: String): Response {
        val text = try {
            hlsFetch(raw).toString(Charsets.UTF_8)
        } catch (e: Exception) {
            return Response.Error("${e.javaClass.simpleName}: ${e.message}", 502)
        }
        val audio = mutableListOf<JSONObject>()
        val video = mutableListOf<JSONObject>()
        val lines = text.split("\n")
        var i = 0
        while (i < lines.size) {
            val ln = lines[i].trim()
            if (ln.startsWith("#EXT-X-MEDIA") && ln.contains("TYPE=AUDIO")) {
                val uri = Regex("URI=\"([^\"]*)\"").find(ln)?.groupValues?.get(1)
                val lang = Regex("LANGUAGE=\"([^\"]*)\"").find(ln)?.groupValues?.get(1)
                val name = Regex("NAME=\"([^\"]*)\"").find(ln)?.groupValues?.get(1)
                if (uri != null) {
                    audio.add(JSONObject().apply {
                        put("lang", (lang ?: "") ?: "und")
                        put("name", (name ?: "") ?: (lang ?: "audio"))
                        put("uri", hlsProxied(urlJoin(raw, uri)))
                    })
                }
            } else if (ln.startsWith("#EXT-X-STREAM-INF")) {
                val bw = Regex("BANDWIDTH=(\\d+)").find(ln)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                val codecs = Regex("CODECS=\"([^\"]*)\"").find(ln)?.groupValues?.get(1) ?: ""
                var j = i + 1
                while (j < lines.size && lines[j].trim().isEmpty()) j++
                if (j < lines.size) {
                    val vurl = lines[j].trim()
                    video.add(JSONObject().apply {
                        put("bandwidth", bw)
                        put("codecs", codecs)
                        put("uri", hlsProxied(urlJoin(raw, vurl)))
                    })
                }
            }
            i++
        }
        video.sortBy { it.getInt("bandwidth") }
        val result = JSONObject().apply {
            put("audio", JSONArray().apply { audio.forEach { put(it) } })
            put("video", JSONArray().apply { video.forEach { put(it) } })
        }
        return Response.JsonObject(result)
    }

    private fun writeHttp(out: OutputStream, code: Int, ctype: String, body: ByteArray, extraHeaders: Map<String, String> = emptyMap()) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 $code ${httpReason(code)}\r\n")
        sb.append("Content-Type: $ctype\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Methods: GET, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: *\r\n")
        extraHeaders.forEach { (k, v) -> sb.append("$k: $v\r\n") }
        sb.append("Content-Length: ${body.size}\r\n")
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun writeJson(out: OutputStream, code: Int, json: JSONObject) {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        writeHttp(out, code, "application/json; charset=utf-8", body)
    }

    private fun writeJsonArray(out: OutputStream, code: Int, json: JSONArray) {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        writeHttp(out, code, "application/json; charset=utf-8", body)
    }

    private fun writeCors(out: OutputStream, code: Int) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 $code ${httpReason(code)}\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Methods: GET, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: *\r\n")
        sb.append("Content-Length: 0\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.flush()
    }

    private fun httpReason(code: Int): String = when (code) {
        200 -> "OK"
        204 -> "No Content"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        502 -> "Bad Gateway"
        else -> "OK"
    }

    private fun sanitizeAssetPath(path: String): String {
        val parts = path.split("/").toMutableList()
        val result = mutableListOf<String>()
        for (part in parts) {
            when (part) {
                "", "." -> {}
                ".." -> if (result.isNotEmpty()) result.removeAt(result.size - 1)
                else -> result.add(part)
            }
        }
        return result.joinToString("/")
    }

    private fun guessContentType(path: String): String {
        val ext = path.substringAfterLast(".").lowercase()
        return when (ext) {
            "html" -> "text/html"
            "css" -> "text/css"
            "js" -> "application/javascript"
            "json" -> "application/json"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "ico" -> "image/x-icon"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "webmanifest" -> "application/manifest+json"
            "m3u8" -> "application/vnd.apple.mpegurl"
            "ts" -> "video/mp2t"
            "key" -> "application/octet-stream"
            "vtt" -> "text/vtt"
            else -> "application/octet-stream"
        }
    }

    private fun queryParam(query: String?, name: String, default: String? = null): String? {
        if (query.isNullOrEmpty()) return default
        query.split("&").forEach { pair ->
            val idx = pair.indexOf("=")
            if (idx > 0) {
                val key = URLDecoder.decode(pair.substring(0, idx), "UTF-8")
                val value = URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
                if (key == name) return value
            }
        }
        return default
    }

    private fun hlsFetch(target: String): ByteArray {
        val conn = URL(target).openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 20000
        conn.readTimeout = 20000
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        conn.setRequestProperty("Referer", "https://play.zephyrix.org/")
        conn.setRequestProperty("Origin", "https://play.zephyrix.org")
        conn.setRequestProperty("Accept", "*/*")
        conn.inputStream.use { return it.readBytes() }
    }

    private fun hlsAllowed(url: String): Boolean {
        val host = try { URL(url).host.lowercase() } catch (e: Exception) { return false }
        return HLS_ALLOWED.matcher(host).matches()
    }

    private fun urlJoin(base: String, relative: String): String {
        return try { URL(URL(base), relative).toString() } catch (e: Exception) { relative }
    }

    private fun hlsProxied(absUrl: String): String {
        return "/api/v1/hls?url=" + URLEncoder.encode(absUrl, "UTF-8")
    }

    private fun filterMaster(text: String, sel: String): String {
        val lines = text.split("\n")
        val keep: MutableSet<String>? = if (sel.isNotEmpty() && sel != "*") {
            val s = sel.lowercase()
            val found = mutableSetOf<String>()
            for (ln in lines) {
                val st = ln.trim()
                if (st.startsWith("#EXT-X-MEDIA") && st.contains("TYPE=AUDIO")) {
                    val lang = Regex("LANGUAGE=\"([^\"]*)\"").find(st)?.groupValues?.get(1)
                    val name = Regex("NAME=\"([^\"]*)\"").find(st)?.groupValues?.get(1)
                    val lval = ((lang ?: "") ?: (name ?: "")).lowercase()
                    if (s in lval || lval in s) {
                        val uri = Regex("URI=\"([^\"]*)\"").find(st)?.groupValues?.get(1)
                        if (uri != null) found.add(uri)
                        break
                    }
                }
            }
            found
        } else null

        val out = mutableListOf<String>()
        for (ln in lines) {
            val st = ln.trim()
            if (st.startsWith("#EXT-X-MEDIA") && st.contains("TYPE=AUDIO")) {
                if (keep == null) {
                    out.add(ln)
                } else {
                    val uri = Regex("URI=\"([^\"]*)\"").find(st)?.groupValues?.get(1)
                    if (uri != null && uri in keep) out.add(ln)
                }
            } else {
                out.add(ln)
            }
        }
        return out.joinToString("\n")
    }

    private fun rewritePlaylist(text: String, baseUrl: String): String {
        val uriPattern = Pattern.compile("URI=\"([^\"]*)\"")
        val matcher = uriPattern.matcher(text)
        val sb = StringBuffer()
        while (matcher.find()) {
            val inner = matcher.group(1)
            val replaced = "URI=\"" + Matcher.quoteReplacement(hlsProxied(urlJoin(baseUrl, inner))) + "\""
            matcher.appendReplacement(sb, replaced)
        }
        matcher.appendTail(sb)
        val result = sb.toString()
        val lines = result.split("\n").toMutableList()
        for (i in lines.indices) {
            val s = lines[i].trim()
            if (s.isNotEmpty() && !s.startsWith("#")) {
                lines[i] = hlsProxied(urlJoin(baseUrl, lines[i].trim()))
            }
        }
        return lines.joinToString("\n")
    }

    private fun guessSegCtype(url: String): String {
        val ext = url.split("?")[0].substringAfterLast(".").lowercase()
        return when (ext) {
            "ts" -> "video/mp2t"
            "m4s" -> "video/iso.segment"
            "m4a" -> "audio/mp4"
            "aac" -> "audio/aac"
            "mp3" -> "audio/mpeg"
            "mp4" -> "video/mp4"
            "key" -> "application/octet-stream"
            "vtt" -> "text/vtt"
            else -> "application/octet-stream"
        }
    }

    private fun lanIp(): String {
        return try {
            java.net.Socket().use { socket ->
                socket.connect(InetSocketAddress("8.8.8.8", 80), 2000)
                socket.localAddress.hostAddress ?: "127.0.0.1"
            }
        } catch (e: Exception) {
            "127.0.0.1"
        }
    }
}
