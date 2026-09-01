package com.animeworld

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.regex.Pattern

object AnimeClient {
    const val SITE = "https://watchanimeworld.one"
    const val PLAYER_HOST = "play.zephyrix.org"
    const val PLAYER = "https://$PLAYER_HOST"
    const val AJAX = "$SITE/wp-admin/admin-ajax.php"
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    private const val REFERRER = "$SITE/"

    private val FEED_MODE = mapOf(
        "newest" to ("series" to "1"),
        "trending" to ("series" to "2"),
        "movies" to ("movies" to "2")
    )

    @Throws(Exception::class)
    fun http(
        url: String,
        headers: Map<String, String>? = null,
        data: Any? = null,
        timeout: Int = 40,
        retries: Int = 4
    ): String {
        val h = mutableMapOf("User-Agent" to UA, "Accept" to "*/*")
        headers?.forEach { h[it.key] = it.value }

        var body: ByteArray? = null
        var method = "GET"
        if (data != null) {
            method = "POST"
            when (data) {
                is ByteArray -> body = data
                is Map<*, *> -> {
                    body = data.entries.joinToString("&") {
                        "${URLEncoder.encode(it.key.toString(), "UTF-8")}=${URLEncoder.encode(it.value.toString(), "UTF-8")}"
                    }.toByteArray(Charsets.UTF_8)
                    h["Content-Type"] = "application/x-www-form-urlencoded"
                }
                else -> {
                    body = data.toString().toByteArray(Charsets.UTF_8)
                }
            }
            h["X-Requested-With"] = "XMLHttpRequest"
        }

        var last: Exception? = null
        repeat(retries) {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = method
                conn.connectTimeout = timeout * 1000
                conn.readTimeout = timeout * 1000
                h.forEach { (k, v) -> conn.setRequestProperty(k, v) }
                body?.let { b ->
                    conn.doOutput = true
                    conn.outputStream.use { os -> os.write(b) }
                }
                conn.inputStream.use { stream ->
                    return BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
                }
            } catch (e: Exception) {
                last = e
                Thread.sleep(1200)
            }
        }
        throw last ?: Exception("HTTP request failed after $retries retries")
    }

    private fun postForm(url: String, fields: Map<String, String>, timeout: Int = 40): String {
        return http(url, data = fields, timeout = timeout)
    }

    private fun tmdb(url: String?, size: String = "w500"): String? {
        if (url.isNullOrEmpty()) return null
        var result = if (url.startsWith("//")) "https:$url" else url
        result = Pattern.compile("/t/p/[^/]+/").matcher(result).replaceAll("/t/p/$size/")
        return result
    }

    private fun slugTitle(slug: String): String {
        return slug.replace("-", " ").split(" ").joinToString(" ") { word ->
            if (word.isNotEmpty()) word[0].uppercase() + word.substring(1) else word
        }
    }

    fun search(query: String, limit: Int = 20): List<Map<String, String>> {
        val html = http("$SITE/?s=${URLEncoder.encode(query, "UTF-8")}")
        val out = mutableListOf<Map<String, String>>()
        val seen = mutableSetOf<String>()
        val regex = Pattern.compile("""href="(https://watchanimeworld\.one/series/([^"/]+)/)"[^>]*>(.*?)</a>""", Pattern.CASE_INSENSITIVE or Pattern.DOTALL)
        val matcher = regex.matcher(html)
        while (matcher.find()) {
            val url = matcher.group(1)
            val slug = matcher.group(2)
            if (slug in seen) continue
            seen.add(slug)
            var title = matcher.group(3).replace(Regex("<[^>]+>"), "").trim()
            if (title.isEmpty()) title = slugTitle(slug)
            out.add(mapOf("title" to title, "slug" to slug, "url" to url))
            if (out.size >= limit) break
        }
        return out
    }

    fun feed(kind: String = "newest", category: String = "all", page: Int = 1, limit: Int = 25): List<Map<String, String>> {
        val mode = FEED_MODE[kind] ?: FEED_MODE["newest"]!!
        val html = postForm(AJAX, mapOf(
            "action" to "action_tr_movie_category",
            "post" to mode.first,
            "category" to category,
            "mode" to mode.second,
            "limit" to limit.toString(),
            "page" to page.toString()
        ))
        val links = mutableListOf<Pair<String, String>>()
        val linkRegex = Pattern.compile("""href="(https://watchanimeworld\.one/(?:series|movies)/([^"/]+)/)"""")
        val linkMatcher = linkRegex.matcher(html)
        while (linkMatcher.find()) {
            links.add(linkMatcher.group(1) to linkMatcher.group(2))
        }
        val imgs = mutableListOf<String>()
        val imgRegex = Pattern.compile("""src="(//image\.tmdb\.org/[^"]+)"""")
        val imgMatcher = imgRegex.matcher(html)
        while (imgMatcher.find()) {
            imgs.add(imgMatcher.group(1))
        }
        val out = mutableListOf<Map<String, String>>()
        val seen = mutableSetOf<String>()
        links.forEachIndexed { i, (url, slug) ->
            if (slug in seen) return@forEachIndexed
            seen.add(slug)
            val poster = if (i < imgs.size) tmdb(imgs[i]) ?: "" else ""
            out.add(mapOf("title" to slugTitle(slug), "slug" to slug, "url" to url, "poster" to poster))
        }
        return out
    }

    fun categories(perPage: Int = 100): List<Map<String, String>> {
        return try {
            val data = http("$SITE/wp-json/wp/v2/categories?per_page=$perPage")
            val arr = JSONArray(data)
            List(arr.length()) { i ->
                val obj = arr.getJSONObject(i)
                mapOf("name" to obj.optString("name"), "slug" to obj.optString("slug"))
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun series(slug: String): Map<String, Any?> {
        val html = http("$SITE/series/$slug/")
        val postId = Regex("""data-post="(\d+)"""").find(html)?.groupValues?.get(1)
            ?: Regex("""postid-(\d+)""").find(html)?.groupValues?.get(1)
        val seasons = Regex("""data-season="(\d+)"""").findAll(html).map { it.groupValues[1].toInt() }.toSet().sorted()
        val title = Regex("<title>([^<]+)</title>").find(html)?.groupValues?.get(1)?.split(" - ")?.get(0)?.trim() ?: ""
        return mapOf(
            "slug" to slug,
            "title" to if (title.isEmpty()) slugTitle(slug) else title,
            "post_id" to postId,
            "seasons" to seasons
        )
    }

    fun episodes(postId: Any, season: Int): List<Map<String, Any>> {
        val html = postForm(AJAX, mapOf(
            "action" to "action_select_season",
            "season" to season.toString(),
            "post" to postId.toString()
        ))
        val out = mutableListOf<Map<String, Any>>()
        val regex = Regex("""href="(https://[^"]*?/episode/([^"/]+)/)"""")
        regex.findAll(html).forEach { m ->
            val full = m.groupValues[1]
            val slug = m.groupValues[2]
            val episodeMatch = Regex("""(\d+)x(\d+)""").find(slug)
            if (episodeMatch != null) {
                out.add(mapOf(
                    "season" to episodeMatch.groupValues[1].toInt(),
                    "episode" to episodeMatch.groupValues[2].toInt(),
                    "slug" to slug,
                    "url" to full
                ))
            }
        }
        out.sortWith(compareBy({ it["season"] as Int }, { it["episode"] as Int }))
        return out
    }

    fun allSeasons(postId: Any, seasons: List<Int>): Map<Int, List<Map<String, Any>>> {
        return seasons.associateWith { episodes(postId, it) }
    }

    fun episodePlayerId(episodeUrl: String): String {
        val html = http(episodeUrl, headers = mapOf("Referer" to REFERRER))
        val m = Regex("""${Pattern.quote(PLAYER_HOST)}/video/([a-f0-9]+)""").find(html)
        if (m == null) throw RuntimeException("player id not found on $episodeUrl")
        return m.groupValues[1]
    }

    fun episodeStream(episodeUrl: String? = null, playerId: String? = null): Map<String, Any?> {
        val pid = playerId ?: episodePlayerId(episodeUrl!!)
        val url = "$PLAYER/player/index.php?data=$pid&do=getVideo"
        val raw = http(
            url,
            headers = mapOf(
                "Referer" to "$PLAYER/",
                "Origin" to "$PLAYER/",
                "X-Requested-With" to "XMLHttpRequest"
            ),
            data = ByteArray(0),
            timeout = 30
        )
        val data = JSONObject(raw)
        val dl = data.opt("downloadLinks")
        val dlValue = when {
            dl is JSONObject -> dl.toMap()
            dl is JSONArray -> dl.toList()
            else -> data.optString("downloadLinks", "")
        }
        return mapOf(
            "player_id" to pid,
            "source_url" to episodeUrl,
            "hls" to data.optString("hls", ""),
            "video_source" to data.optString("videoSource", ""),
            "secured_link" to data.optString("securedLink", ""),
            "poster" to data.optString("videoImage", ""),
            "download_links" to dlValue
        )
    }

    fun JSONObject.toMap(): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        keys().forEach { key ->
            val value = opt(key)
            map[key] = when (value) {
                is JSONObject -> value.toMap()
                is JSONArray -> value.toList()
                JSONObject.NULL -> null
                else -> value
            }
        }
        return map
    }

    fun JSONArray.toList(): List<Any?> {
        val list = mutableListOf<Any?>()
        for (i in 0 until length()) {
            val value = opt(i)
            list.add(when (value) {
                is JSONObject -> value.toMap()
                is JSONArray -> value.toList()
                JSONObject.NULL -> null
                else -> value
            })
        }
        return list
    }
}
