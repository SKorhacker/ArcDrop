package app.arcdrop.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.SharedPreferences
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts the ArcDrop web app (bundled in assets, served from https://appassets.androidplatform.net,
 * so it works offline and is a secure context for the camera) and gives it what a browser can't:
 * the Bluetooth mesh, the share sheet (Quick Share), an encrypted key store and haptics.
 *
 * JS -> native: ArcMeshAndroid.postMessage(JSON) — a WebMessageListener that only exists on the
 *               app's own origin, main frame only. Messages: broadcast, profile, presence, share,
 *               haptic, saveKey (same protocol as the iOS app), readClipboard (Android only).
 * native -> JS: arcdropReceive(packet, hops), arcdropReceipt, arcdropNearby, arcdropMeshPeers,
 *               arcdropOpenURL, arcdropKeySaved, arcdropClipboard.
 */
class MainActivity : Activity(), ArcMesh.Listener {

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val PAGE = "$ORIGIN/assets/web/index.html"
        const val PERMISSIONS_REQUEST = 1
        const val CAMERA_REQUEST = 2
    }

    private lateinit var webView: WebView
    private lateinit var mesh: ArcMesh
    private var loaded = false
    private val pendingUrls = ArrayList<String>()
    private var pendingCamera: PermissionRequest? = null
    private var peers = 0
    private val pendingCalls = ArrayList<Pair<String, Array<out Any?>>>()
    private var keyScript: ScriptHandler? = null
    private var canInject = false

    // The Android keystore can break (OS update, lock screen change): never crash on it. When it is
    // unusable, the web app keeps its own copy of the key (saveKey answers false).
    private val keyStore: SharedPreferences? by lazy {
        try {
            EncryptedSharedPreferences.create(
                this, "arcdrop_wallet",
                MasterKey.Builder(this).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) { null }
    }

    private fun savedKey(): String? = try { keyStore?.getString("key", null) } catch (e: Exception) { null }

    /** The key is injected before the page's scripts on every load (re-registered whenever it changes). */
    private fun injectKey(key: String) {
        if (!canInject) return
        keyScript?.remove()
        keyScript = WebViewCompat.addDocumentStartJavaScript(webView, "globalThis.ARCDROP_NATIVE_KEY = ${JSONObject.quote(key)};", setOf(ORIGIN))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mesh = ArcMesh(this, this)

        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.setBackgroundColor(0xFF000000.toInt())

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // Only the bundled app loads in the web view; https links (the explorer) open in the browser
            // on a user tap; every other scheme is refused.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.toString().startsWith("$ORIGIN/")) return false
                if (url.scheme == "https" && request.hasGesture()) open(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            // The page's renderer was killed (memory): rebuild the screen instead of crashing the app.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                runOnUiThread { recreate() }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                loaded = true
                pendingCalls.forEach { (f, args) -> call(f, *args) }
                pendingCalls.clear()
                call("arcdropMeshPeers", peers)
                pendingUrls.forEach { call("arcdropOpenURL", it) }
                pendingUrls.clear()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // Camera for the QR scanner: only for our own page, and only once Android granted it.
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.origin.toString().trimEnd('/') != ORIGIN || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        request.deny(); return@runOnUiThread
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingCamera?.deny()
                        pendingCamera = request
                        requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
                    }
                }
            }
        }

        // The wallet key, decrypted from the Android keystore, injected before the page's scripts run.
        canInject = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        savedKey()?.let { injectKey(it) }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "ArcMeshAndroid", setOf(ORIGIN)) { _, message, sourceOrigin, isMainFrame, _: JavaScriptReplyProxy ->
                if (isMainFrame && sourceOrigin.toString().trimEnd('/') == ORIGIN) onBridge(message)
            }
        }

        setContentView(webView)
        // A recreated screen, or a launch from Recents, must not replay an old payment link.
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) handleIntent(intent)
        webView.loadUrl(PAGE)
        requestMeshPermissions()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val url = intent?.data?.takeIf { it.scheme == "arcdrop" || (it.scheme == "https" && it.host == "arcdrop-pink.vercel.app") }?.toString() ?: return
        if (loaded) call("arcdropOpenURL", url) else if (pendingUrls.size < 10) pendingUrls.add(url)
    }

    override fun onDestroy() {
        mesh.stop()
        super.onDestroy()
    }

    // ---------------- permissions ----------------

    private fun meshPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun requestMeshPermissions() {
        val missing = meshPermissions().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) mesh.start() else requestPermissions(missing.toTypedArray(), PERMISSIONS_REQUEST)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            PERMISSIONS_REQUEST -> if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) mesh.start()
            CAMERA_REQUEST -> {
                val req = pendingCamera ?: return
                pendingCamera = null
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else req.deny()
            }
        }
    }

    // ---------------- JS -> native ----------------

    private fun onBridge(message: WebMessageCompat) {
        val body = try { JSONObject(message.data ?: return) } catch (e: Exception) { return }
        when (body.optString("type")) {
            "broadcast" -> body.optString("packet").takeIf { it.isNotEmpty() }?.let { mesh.broadcast(it) }
            "vouch" -> body.optString("packet").takeIf { it.isNotEmpty() }?.let { mesh.vouch(it, body.optInt("hops", 0)) }
            "profile" -> body.optString("address").takeIf { it.isNotEmpty() }?.let { mesh.setProfile(it, body.optString("name")) }
            "presence" -> if (!body.optBoolean("on", true)) mesh.stopPresence()
            "share" -> {
                val text = listOf(body.optString("text"), body.optString("url")).filter { it.isNotEmpty() }.joinToString("\n")
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                open(Intent.createChooser(send, "Envoyer le paiement"))
            }
            "haptic" -> vibrate(body.optString("kind"))
            "readClipboard" -> {
                // Only when the user tapped "Coller" (the page asks), only text, bounded.
                val clip = (getSystemService(ClipboardManager::class.java))?.primaryClip
                val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString().orEmpty() else ""
                call("arcdropClipboard", text.take(4096))
            }
            "saveKey" -> {
                // Never overwrite an existing wallet unless the user explicitly imported a key.
                // Answer false whenever the key couldn't be stored AND re-injected on the next load:
                // the web app then keeps its own copy, so the wallet is never lost.
                val key = body.optString("key").takeIf { Regex("^0x[0-9a-fA-F]{64}$").matches(it) } ?: return
                val store = keyStore
                if (store == null || !canInject) { call("arcdropKeySaved", false); return }
                val ok = try {
                    val existing = store.getString("key", null)
                    if (existing == null || body.optBoolean("replace", false)) store.edit().putString("key", key).commit() else existing == key
                } catch (e: Exception) { false }
                if (ok) injectKey(key)
                call("arcdropKeySaved", ok)
            }
        }
    }

    private fun vibrate(kind: String) {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) (getSystemService(VibratorManager::class.java)).defaultVibrator else @Suppress("DEPRECATION") getSystemService(Vibrator::class.java)
        val effect = when (kind) {
            "light" -> VibrationEffect.createOneShot(15, VibrationEffect.DEFAULT_AMPLITUDE)
            "error" -> VibrationEffect.createWaveform(longArrayOf(0, 40, 60, 40), -1)
            else -> VibrationEffect.createWaveform(longArrayOf(0, 20, 60, 30), -1)
        }
        vibrator?.vibrate(effect)
    }

    // ---------------- mesh -> JS ----------------

    override fun onPayment(packet: String, hops: Int) = call("arcdropReceive", packet, hops)
    override fun onReceipt(receipt: String) = call("arcdropReceipt", receipt)
    override fun onPeers(count: Int) { peers = count; call("arcdropMeshPeers", count) }
    override fun onNearby(peers: List<ArcMesh.NearbyPeer>) {
        val list = JSONArray()
        peers.forEach { list.put(JSONObject().put("address", it.address).put("name", it.name).put("rssi", it.rssi ?: JSONObject.NULL)) }
        call("arcdropNearby", list)
    }

    private fun open(intent: Intent) {
        try { startActivity(intent) } catch (e: ActivityNotFoundException) {}
    }

    /** Calls a global JS function with JSON-encoded arguments (no string concatenation of raw data).
     *  Before the page has loaded, calls are held (a payment arriving during startup isn't lost). */
    private fun call(function: String, vararg args: Any?) {
        if (!loaded) { if (pendingCalls.size < 200) pendingCalls.add(function to args); return }
        val json = JSONArray().apply { args.forEach { put(it ?: JSONObject.NULL) } }.toString()
        runOnUiThread { webView.evaluateJavascript("globalThis.$function && globalThis.$function(...$json)", null) }
    }
}
