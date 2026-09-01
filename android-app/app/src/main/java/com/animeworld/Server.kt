package com.animeworld

import android.content.Context
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.regex.Matcher
import java.util.regex.Pattern

class Server(private val context: Context) {
    private lateinit var server: HttpServer
    private val port = 8080

    private data class CacheEntry(val timestamp: Long, val data: ByteArray, val ctype: String)

    private val hlsCache = ConcurrentHashMap<String, CacheEntry>()
    private const val HLS_CACHE_TTL = 120L
    private val HLS_ALLOWED = Pattern.compile("^(?:play\\.zephyrix\\.org|s\\d+\\.zn-grid\\d+\\.top|zn-grid\\d+\\.top)$")

    sealed class Response {
        data class JsonObject(val json: JSONObject) : Response()
        data class JsonArray(val json: JSONArray) : Response()
        data class Error(val msg: String, val code: Int = 400) : Response()
    }

    fun start() {
        server = HttpServer.create(InetSocketAddress("0.0.0.0", port), 0)
        server.executor = null

        server.createContext("/") { exchange -> serveStatic(exchange) }
        server.createContext("/api/v1/health") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/search") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/feed") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/categories") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/series") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/seasons") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/episodes") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/stream") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/ext_url") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/tracks") { exchange -> handleApi(exchange) }
        server.createContext("/api/v1/hls") { exchange -> handleHls(exchange) }
        server.createContext("/api/v1/hls.m3u8") { exchange -> handleHls(exchange) }

        server.setLogger(null)
        server.start()
    }

    private fun serveStatic(exchange: HttpExchange) {
        if (exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) {
            sendCors(exchange)
            return
        }
        val path = exchange.requestURI.path ?: "/"
        val assetPath = if (path == "/" || path.isEmpty()) "www/index.html" else "www$path"
        val sanitized = sanitizeAssetPath(assetPath)

        try {
            context.assets.open(sanitized).use { input ->
                val data = input.readBytes()
                exchange.responseHeaders["Content-Type"] = guessContentType(path)
                exchange.responseHeaders["Cache-Control"] = "no-store"
                addCorsHeaders(exchange.responseHeaders)
                exchange.sendResponseHeaders(200, data.size.toLong())
                exchange.responseBody.use { it.write(data) }
                exchange.close()
            }
        } catch (e: Exception) {
            try {
                context.assets.open("www/index.html").use { input ->
                    val data = input.readBytes()
                    exchange.responseHeaders["Content-Type"] = "text/html"
                    exchange.responseHeaders["Cache-Control"] = "no-store"
                    addCorsHeaders(exchange.responseHeaders)
                    exchange.sendResponseHeaders(200, data.size.toLong())
                    exchange.responseBody.use { it.write(data) }
                    exchange.close()
                }
            } catch (e2: Exception) {
                val msg = "Not Found".toByteArray(Charsets.UTF_8)
                exchange.responseHeaders["Content-Type"] = "text/plain"
                addCorsHeaders(exchange.responseHeaders)
                exchange.sendResponseHeaders(404, msg.size.toLong())
                exchange.responseBody.use { it.write(msg) }
                exchange.close()
            }
        }
    }

    private fun handleApi(exchange: HttpExchange) {
        if (exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) {
            sendCors(exchange)
            return
        }
        if (exchange.requestMethod != "GET") {
            sendError(exchange, "Method Not Allowed", 405)
            return
        }
        val path = exchange.requestURI.path ?: ""
        val query = exchange.requestURI.query
        try {
            when (val resp = apiRoute(path, query)) {
                is Response.JsonObject -> sendJson(exchange, resp.json)
                is Response.JsonArray -> sendJsonArray(exchange, resp.json)
                is Response.Error -> sendError(exchange, resp.msg, resp.code)
            }
        } catch (e: Exception) {
            sendError(exchange, "${e.javaClass.simpleName}: ${e.message}", 502)
        }
    }

    private fun handleHls(exchange: HttpExchange) {
        if (exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) {
            sendCors(exchange)
            return
        }
        if (exchange.requestMethod != "GET") {
            sendError(exchange, "Method Not Allowed", 405)
            return
        }
        val query = exchange.requestURI.query
        val target = queryParam(query, "url", "") ?: ""
        if (target.isEmpty()) {
            sendError(exchange, "missing ?url=", 400)
            return
        }
        if (!hlsAllowed(target)) {
            sendError(exchange, "host not allowed", 403)
            return
        }

        val now = System.currentTimeMillis() / 1000
        val cached = hlsCache[target]
        if (cached != null && now - cached.timestamp < HLS_CACHE_TTL) {
            sendRaw(exchange, cached.data, cached.ctype)
            return
        }

        try {
            val raw = hlsFetch(target)
            val text = raw.toString(Charsets.UTF_8)
            if (text.trimStart().startsWith("#EXTM3U")) {
                val audioSel = queryParam(query, "audio", "")
                val out = if (!audioSel.isNullOrEmpty()) filterMaster(text, audioSel) else text
                val rewritten = rewritePlaylist(out, target)
                val ctype = "application/vnd.apple.mpegurl; charset=utf-8"
                hlsCache[target] = CacheEntry(now, rewritten.toByteArray(Charsets.UTF_8), ctype)
                sendRaw(exchange, rewritten.toByteArray(Charsets.UTF_8), ctype)
            } else {
                val ctype = guessSegCtype(target)
                sendRaw(exchange, raw, ctype)
            }
        } catch (e: Exception) {
            val msg = "${e.javaClass.simpleName}: ${e.message}".toByteArray(Charsets.UTF_8)
            exchange.responseHeaders["Content-Type"] = "text/plain"
            addCorsHeaders(exchange.responseHeaders)
            exchange.sendResponseHeaders(502, msg.size.toLong())
            exchange.responseBody.use { it.write(msg) }
            exchange.close()
        }
    }

    private fun apiRoute(path: String, query: String?): Response {
        return when (path) {
            "/api/v1/health" -> {
                Response.JsonObject(JSONObject().apply {
                    put("status", "ok")
                    put("site", AnimeClient.SITE)
                    put("player", AnimeClient.PLAYER)
                })
            }
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
                val slug = queryParam(query, "slug", "") ?: ""
                val season = queryParam(query, "season", null)
                if (slug.isEmpty() || season == null) return Response.Error("missing ?slug= and ?season=")
                val s = AnimeClient.series(slug)
                val postId = s["post_id"] as? String ?: return Response.Error("series not found", 404)
                val eps = AnimeClient.episodes(postId, season.toInt())
                val arr = JSONArray()
                eps.forEach { arr.put(JSONObject(it)) }
                Response.JsonArray(arr)
            }
            "/api/v1/stream" -> {
                val slug = queryParam(query, "slug", "")
                val url = queryParam(query, "url", "")
                val series = queryParam(query, "series", "")
                val season = queryParam(query, "season", null)
                val episode = queryParam(query, "episode", null)
                var streamUrl = url
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
                val base = "http://${lanIp()}:$PORT/api/v1/hls.m3u8?url="
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

    private fun addCorsHeaders(headers: com.sun.net.httpserver.Headers) {
        headers["Access-Control-Allow-Origin"] = listOf("*")
        headers["Access-Control-Allow-Methods"] = listOf("GET, OPTIONS")
        headers["Access-Control-Allow-Headers"] = listOf("*")
    }

    private fun sendCors(exchange: HttpExchange) {
        exchange.responseHeaders["Access-Control-Allow-Origin"] = "*"
        exchange.responseHeaders["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        exchange.responseHeaders["Access-Control-Allow-Headers"] = "*"
        exchange.sendResponseHeaders(204, -1)
        exchange.close()
    }

    private fun sendJson(exchange: HttpExchange, json: JSONObject, code: Int = 200) {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        exchange.responseHeaders["Content-Type"] = "application/json; charset=utf-8"
        addCorsHeaders(exchange.responseHeaders)
        exchange.sendResponseHeaders(code, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
        exchange.close()
    }

    private fun sendJsonArray(exchange: HttpExchange, json: JSONArray, code: Int = 200) {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        exchange.responseHeaders["Content-Type"] = "application/json; charset=utf-8"
        addCorsHeaders(exchange.responseHeaders)
        exchange.sendResponseHeaders(code, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
        exchange.close()
    }

    private fun sendError(exchange: HttpExchange, msg: String, code: Int = 400) {
        val json = JSONObject().put("error", msg)
        sendJson(exchange, json, code)
    }

    private fun sendRaw(exchange: HttpExchange, data: ByteArray, ctype: String) {
        exchange.responseHeaders["Content-Type"] = ctype
        addCorsHeaders(exchange.responseHeaders)
        exchange.sendResponseHeaders(200, data.size.toLong())
        exchange.responseBody.use { it.write(data) }
        exchange.close()
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

    @Throws(Exception::class)
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
        return try {
            URL(URL(base), relative).toString()
        } catch (e: Exception) {
            relative
        }
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
        val lines = result.split("\n")
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
