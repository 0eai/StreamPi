package com.example.streampitv.ui.screens

import android.util.Log
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiClient
import com.example.streampitv.data.KunjiCodeRequest
import com.example.streampitv.data.KunjiConfig
import com.example.streampitv.data.KunjiFinalizeRequest
import com.example.streampitv.data.KunjiPayload
import com.example.streampitv.data.KunjiSession
import com.example.streampitv.data.KunjiSessionRequest
import com.example.streampitv.data.LoginRequest
import com.example.streampitv.ui.components.BrandMark
import com.example.streampitv.ui.components.FocusableItem
import com.example.streampitv.ui.components.rememberQrImage
import com.example.streampitv.util.catching
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.example.streampitv.ui.theme.Tokens

/**
 * kunji is the primary path, matching the web client (whose LoginScreen starts in the kunji
 * phase and treats the password form as the fallback reached via a button).
 *
 * NOT_LINKED is its own phase rather than a generic error because it is the one failure a
 * user can actually act on: /api/auth/kunji/finalize answers 403 when no StreamPi account
 * carries that kunji sub, and linking requires an already-authenticated session.
 *
 * EXPIRED is also distinct: the code is deliberately NOT reissued automatically, so an
 * unattended TV stops asking kunji for sessions it will never use.
 */
private enum class KunjiPhase { LOADING, READY, EXPIRED, SIGNING_IN, NOT_LINKED, ERROR, PASSWORD }

private const val POLL_INTERVAL_MS = 2_000L

@Composable
fun LoginScreen(
    serverUrl: String,
    /** Why the user is looking at this screen when they did not ask to sign out — currently
     *  only set when the stored session was rejected as expired. */
    notice: String? = null,
    onLoginSuccess: (token: String, username: String?, role: String?) -> Unit,
    onResetServer: () -> Unit
) {
    val api = remember(serverUrl) { ApiClient.of(serverUrl) }

    var phase by remember { mutableStateOf(KunjiPhase.LOADING) }
    var kunjiError by remember { mutableStateOf<String?>(null) }
    var config by remember { mutableStateOf<KunjiConfig?>(null) }
    var session by remember { mutableStateOf<KunjiSession?>(null) }
    var otp by remember { mutableStateOf<String?>(null) }
    var secondsLeft by remember { mutableIntStateOf(0) }
    var attempt by remember { mutableIntStateOf(0) }

    val newCodeFocus = remember { FocusRequester() }

    // ── Start (or restart) a kunji session ──────────────────────────────────
    LaunchedEffect(attempt) {
        if (phase == KunjiPhase.PASSWORD) return@LaunchedEffect
        phase = KunjiPhase.LOADING
        kunjiError = null
        session = null
        otp = null
        catching {
            val cfg = config ?: api.kunjiConfig().also { config = it }
            if (cfg.callbackUrl.isNullOrBlank()) {
                error(cfg.error ?: "kunji login is not configured on this server.")
            }
            api.kunjiSession(
                KunjiSessionRequest(
                    audience = cfg.audience,
                    callbackUrl = cfg.callbackUrl,
                    appName = KunjiPayload.APP_NAME,
                    scope = KunjiPayload.SCOPE
                )
            )
        }.onSuccess {
            session = it
            phase = KunjiPhase.READY
        }.onFailure {
            Log.e("StreamPi", "kunji session failed", it)
            kunjiError = it.message ?: "Could not start kunji sign-in."
            phase = KunjiPhase.ERROR
        }
    }

    // ── Fetch the typable code for this session ─────────────────────────────
    // Served by kunji's callback host, not the StreamPi server. Best-effort: if it fails the
    // QR still works, so a missing code just hides that half of the panel.
    LaunchedEffect(session?.sessionId) {
        otp = null
        val s = session ?: return@LaunchedEffect
        val base = config?.callbackUrl?.trimEnd('/') ?: return@LaunchedEffect
        otp = catching { api.kunjiCode("$base/kunji/session/code", KunjiCodeRequest(s.sessionId)) }
            .onFailure { Log.w("StreamPi", "kunji code failed: ${it.message}") }
            .getOrNull()
            ?.code
            ?.takeIf { it.matches(Regex("^\\d{4,10}$")) }
    }

    // ── Poll for approval, then exchange the identity for a session token ───
    // Keyed on this flag rather than on `phase` directly, and the distinction matters: the
    // effect sets phase = SIGNING_IN itself, so keying on phase made Compose cancel the
    // effect mid-finalize and surface the cancellation as "kunji sign-in unavailable".
    // Spanning READY and SIGNING_IN keeps the key stable across that transition, while
    // still tearing the poll down when the code expires or the user leaves for a password.
    val polling = phase == KunjiPhase.READY || phase == KunjiPhase.SIGNING_IN
    LaunchedEffect(session?.sessionId, polling) {
        val s = session ?: return@LaunchedEffect
        if (!polling) return@LaunchedEffect

        while (true) {
            val remaining = s.expiresAt - System.currentTimeMillis()
            secondsLeft = (remaining / 1000).coerceAtLeast(0).toInt()
            if (remaining <= 0) {
                // Stop here on purpose. Auto-minting a replacement would have a TV sitting
                // on the login screen asking kunji for a new session every two minutes.
                phase = KunjiPhase.EXPIRED
                return@LaunchedEffect
            }

            val status = catching { api.kunjiStatus(s.sessionId) }.getOrNull()
            val sub = status?.sub
            if (status?.status == "approved" && !sub.isNullOrBlank()) {
                phase = KunjiPhase.SIGNING_IN
                catching { api.kunjiFinalize(KunjiFinalizeRequest(s.sessionId, sub)) }
                    .onSuccess { res ->
                        if (res.success && res.token.isNotBlank()) onLoginSuccess(res.token, res.username, res.role)
                        else {
                            kunjiError = "kunji sign-in failed."
                            phase = KunjiPhase.ERROR
                        }
                    }
                    .onFailure { e ->
                        Log.e("StreamPi", "kunji finalize failed", e)
                        val code = (e as? retrofit2.HttpException)?.code()
                        // 403 covers both "no linked account" and pending/rejected status.
                        if (code == 403) phase = KunjiPhase.NOT_LINKED
                        else {
                            kunjiError = e.message ?: "kunji sign-in failed."
                            phase = KunjiPhase.ERROR
                        }
                    }
                return@LaunchedEffect
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    // Put focus on the one action that matters once the code dies.
    LaunchedEffect(phase) {
        if (phase == KunjiPhase.EXPIRED) runCatching { newCodeFocus.requestFocus() }
    }

    BoxWithConstraints(
        // Tighter than the usual 40dp so the code can claim the height: a 1080p TV is only
        // 540dp tall, and every dp of padding comes straight off the QR.
        modifier = Modifier.fillMaxSize().background(Tokens.bg).padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        // Grow the code to fill whatever is left rather than hardcoding a size, so this
        // still behaves on panels that report a different dp viewport.
        val plateInset = 24.dp          // white quiet-zone border, 12dp per side
        val otpBlock = 92.dp            // spacer + caption + the digits underneath
        val gutter = 40.dp
        val minLeftColumn = 380.dp      // below this the copy stops being readable
        val qrSize = minOf(
            maxHeight - otpBlock - plateInset,
            maxWidth - gutter - minLeftColumn - plateInset
        ).coerceIn(180.dp, 560.dp)

        when (phase) {
            KunjiPhase.READY, KunjiPhase.EXPIRED -> {
                val s = session
                val cfg = config
                val expired = phase == KunjiPhase.EXPIRED
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(gutter)
                ) {
                    // ── Left: brand, copy and the actions ──────────────────
                    Column(
                        horizontalAlignment = Alignment.Start,
                        modifier = Modifier.weight(1f)
                    ) {
                        Brand(serverUrl, Alignment.Start)
                        Spacer(Modifier.height(28.dp))

                        if (expired) {
                            Text(
                                "Sign-in code expired",
                                color = Tokens.dangerText,
                                fontSize = 28.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(Modifier.height(10.dp))
                            Text(
                                "Codes are short-lived for your security. Get a new one when " +
                                    "you're ready to scan.",
                                color = Color.Gray,
                                fontSize = 15.sp
                            )
                        } else {
                            Text(
                                "Scan with your kunji app",
                                color = Color.White,
                                fontSize = 28.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(Modifier.height(10.dp))
                            Text(
                                "Open kunji on your phone, scan the code or type the number, " +
                                    "and approve the sign-in. This TV will continue automatically.",
                                color = Color.Gray,
                                fontSize = 15.sp
                            )
                            Spacer(Modifier.height(14.dp))
                            Text(
                                "Code expires in ${secondsLeft}s",
                                color = Tokens.muted,
                                fontSize = 14.sp
                            )
                        }

                        Spacer(Modifier.height(26.dp))
                        if (expired) {
                            PrimaryButton(
                                "New code",
                                icon = Icons.Default.Refresh,
                                modifier = Modifier.focusRequester(newCodeFocus)
                            ) { attempt++ }
                            Spacer(Modifier.height(12.dp))
                            SecondaryButton("Use password instead") { phase = KunjiPhase.PASSWORD }
                        } else {
                            SecondaryButton("Use password instead") { phase = KunjiPhase.PASSWORD }
                            Spacer(Modifier.height(12.dp))
                            SecondaryButton("New code", icon = Icons.Default.Refresh) { attempt++ }
                        }
                    }

                    // ── Right: the code itself ─────────────────────────────
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            Modifier
                                .background(Color.White, RoundedCornerShape(12.dp))
                                .padding(plateInset / 2)
                        ) {
                            if (s != null && cfg != null) {
                                // Encode at exactly the pixel size it will be drawn at, and
                                // disable filtering, so modules land on whole pixels with
                                // hard edges instead of being interpolated into grey mush.
                                val qrPx = with(LocalDensity.current) { qrSize.roundToPx() }
                                Image(
                                    bitmap = rememberQrImage(KunjiPayload.build(s, cfg), qrPx),
                                    contentDescription = "kunji sign-in QR code",
                                    filterQuality = FilterQuality.None,
                                    modifier = Modifier.size(qrSize)
                                )
                            } else {
                                Box(Modifier.size(qrSize))
                            }
                            // Grey the code out rather than removing it, so the panel does
                            // not jump around when it expires.
                            if (expired) {
                                Box(
                                    Modifier
                                        .matchParentSize()
                                        .background(Color.White.copy(alpha = 0.82f)),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        "EXPIRED",
                                        color = Tokens.danger,
                                        fontSize = 36.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }

                        Spacer(Modifier.height(18.dp))
                        Text(
                            "Can't scan? Enter this code",
                            color = Tokens.muted2,
                            fontSize = 13.sp
                        )
                        Spacer(Modifier.height(6.dp))
                        // Placeholder is kept to the same character count as a formatted
                        // code so the panel does not resize when it arrives, and short
                        // enough not to wrap under the 260dp code.
                        Text(
                            text = otp?.let(::formatOtp) ?: "––– –––",
                            color = if (expired) Tokens.muted2 else Color.White,
                            fontSize = 40.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1
                        )
                    }
                }
            }

            KunjiPhase.PASSWORD -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Brand(serverUrl, Alignment.CenterHorizontally)
                Spacer(Modifier.height(20.dp))
                PasswordForm(
                    serverUrl = serverUrl,
                    onLoginSuccess = onLoginSuccess,
                    onResetServer = onResetServer,
                    onUseKunji = { attempt++ }
                )
            }

            KunjiPhase.LOADING -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Brand(serverUrl, Alignment.CenterHorizontally)
                Spacer(Modifier.height(28.dp))
                CircularProgressIndicator(color = Tokens.accent)
                Spacer(Modifier.height(16.dp))
                Text("Preparing kunji sign-in…", color = Color.Gray, fontSize = 15.sp)
                Spacer(Modifier.height(28.dp))
                SecondaryButton("Use password instead") { phase = KunjiPhase.PASSWORD }
            }

            KunjiPhase.SIGNING_IN -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Brand(serverUrl, Alignment.CenterHorizontally)
                Spacer(Modifier.height(28.dp))
                CircularProgressIndicator(color = Tokens.accent)
                Spacer(Modifier.height(16.dp))
                Text("Approved — signing in…", color = Color.White, fontSize = 18.sp)
            }

            KunjiPhase.NOT_LINKED -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Brand(serverUrl, Alignment.CenterHorizontally)
                Spacer(Modifier.height(28.dp))
                Text(
                    "This kunji identity isn't linked yet",
                    color = Tokens.dangerText,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    "Sign in with your username and password once, then link kunji from the " +
                        "StreamPi web app. Your account may also still be awaiting admin approval.",
                    color = Color.Gray,
                    fontSize = 15.sp,
                    modifier = Modifier.width(620.dp)
                )
                Spacer(Modifier.height(28.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    PrimaryButton("Use password") { phase = KunjiPhase.PASSWORD }
                    SecondaryButton("Try kunji again") { attempt++ }
                }
            }

            KunjiPhase.ERROR -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Brand(serverUrl, Alignment.CenterHorizontally)
                Spacer(Modifier.height(28.dp))
                Text("kunji sign-in unavailable", color = Tokens.dangerText, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(10.dp))
                Text(kunjiError.orEmpty(), color = Color.Gray, fontSize = 14.sp, modifier = Modifier.width(620.dp))
                Spacer(Modifier.height(28.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    PrimaryButton("Use password") { phase = KunjiPhase.PASSWORD }
                    SecondaryButton("Retry", icon = Icons.Default.Refresh) { attempt++ }
                }
            }
        }

        // Overlaid at the top rather than placed inside each phase's layout: it has to appear
        // whichever phase is showing, and the QR phase is already fighting for every dp of a
        // 540dp-tall panel.
        if (notice != null) {
            Text(
                notice,
                color = Tokens.warning,
                fontSize = 13.sp,
                modifier = Modifier.align(Alignment.TopCenter)
            )
        }
    }
}

/** rp.js renders the code split after the third digit, e.g. 154523 -> "154 523". */
private fun formatOtp(code: String): String =
    if (code.length > 3) "${code.take(3)} ${code.drop(3)}" else code

@Composable
private fun Brand(serverUrl: String, align: Alignment.Horizontal) {
    Column(horizontalAlignment = align) {
        BrandMark(height = 44.dp)
        Spacer(Modifier.height(6.dp))
        Text("Server: $serverUrl", color = Color.Gray, fontSize = 12.sp)
    }
}

@Composable
private fun PasswordForm(
    serverUrl: String,
    onLoginSuccess: (token: String, username: String?, role: String?) -> Unit,
    onResetServer: () -> Unit,
    onUseKunji: () -> Unit
) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    var hasError by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val userFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) { runCatching { userFocus.requestFocus() } }

    fun submit() {
        if (username.isBlank() || password.isBlank()) return
        isLoading = true
        hasError = false
        scope.launch {
            catching {
                ApiClient.of(serverUrl).login(
                    LoginRequest(
                        username = username,
                        password = password,
                        device = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}".trim(),
                        device_type = "Android TV"
                    )
                )
            }.onSuccess { response ->
                if (response.success) onLoginSuccess(response.token, response.username ?: username, response.role)
                else {
                    isLoading = false
                    hasError = true
                    password = ""
                }
            }.onFailure { e ->
                Log.e("StreamPi", "Login error", e)
                isLoading = false
                hasError = true
                password = ""
            }
        }
    }

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.Lock, contentDescription = null, tint = Tokens.accent, modifier = Modifier.size(40.dp))
        Text("Sign in", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(20.dp))

        if (hasError) {
            Text("Invalid credentials or connection error", color = Color.Red, modifier = Modifier.padding(bottom = 10.dp))
        }

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Username") },
            modifier = Modifier.width(400.dp).focusRequester(userFocus),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Color.Red,
                unfocusedBorderColor = Color.Gray,
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White
            )
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.width(400.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Color.Red,
                unfocusedBorderColor = Color.Gray,
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White
            )
        )
        Spacer(Modifier.height(20.dp))

        FocusableItem(onClick = { submit() }, modifier = Modifier.width(150.dp).height(50.dp)) {
            Box(Modifier.fillMaxSize().background(Color.White), contentAlignment = Alignment.Center) {
                if (isLoading) CircularProgressIndicator(modifier = Modifier.size(24.dp), color = Color.Black)
                else Text("Login", fontWeight = FontWeight.Bold, color = Color.Black)
            }
        }

        Spacer(Modifier.height(28.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            SecondaryButton("Sign in with kunji", onClick = onUseKunji)
            SecondaryButton("Change server", icon = Icons.Default.Edit, onClick = onResetServer)
        }
    }
}

@Composable
private fun PrimaryButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    FocusableItem(onClick = onClick, modifier = modifier.height(48.dp).widthIn(min = 240.dp)) {
        Row(
            modifier = Modifier.fillMaxSize().background(Color.White).padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = Color.Black, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(label, color = Color.Black, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }
    }
}

@Composable
private fun SecondaryButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    FocusableItem(onClick = onClick, modifier = modifier.height(48.dp).widthIn(min = 240.dp)) {
        Row(
            modifier = Modifier.fillMaxSize().background(Tokens.surface2).padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = Color.LightGray, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(label, color = Color.LightGray, fontSize = 15.sp)
        }
    }
}
