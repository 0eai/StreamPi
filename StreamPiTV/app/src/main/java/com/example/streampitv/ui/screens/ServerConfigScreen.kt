package com.example.streampitv.ui.screens

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streampitv.data.ApiService
import com.example.streampitv.data.FirebaseApiService
import com.example.streampitv.data.LoginRequest
import com.example.streampitv.ui.components.FocusableItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit
import com.example.streampitv.ui.theme.Tokens

@Composable
fun ServerConfigScreen(
    onSave: (String) -> Unit,
    initialAutoDiscover: Boolean = true
) {
    var ip by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("3005") }

    var isAutoDiscovering by remember { mutableStateOf(initialAutoDiscover) }
    var statusMessage by remember { mutableStateOf("Searching for server...") }
    var isLoading by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()
    val (ipRef, portRef, btnRef, manualBtnRef) = remember { FocusRequester.createRefs() }

    val fastClient = remember {
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.SECONDS)
            .build()
    }

    fun testConnection(url: String, onSuccess: () -> Unit, onError: (String) -> Unit) {
        scope.launch(Dispatchers.IO) {
            try {
                Log.d("StreamPi", "Testing connection to: $url")
                val retrofit = Retrofit.Builder()
                    .baseUrl(url)
                    .client(fastClient)
                    .addConverterFactory(GsonConverterFactory.create())
                    .build()
                val api = retrofit.create(ApiService::class.java)

                try {
                    api.login(LoginRequest("ping", "ping"))
                } catch (e: retrofit2.HttpException) {
                    // Server responded
                }

                Log.d("StreamPi", "Connection success!")
                withContext(Dispatchers.Main) { onSuccess() }
            } catch (e: Exception) {
                Log.e("StreamPi", "Connection failed: ${e.message}")
                withContext(Dispatchers.Main) { onError(e.message ?: "Connection timed out") }
            }
        }
    }

    LaunchedEffect(isAutoDiscovering) {
        if (!isAutoDiscovering) return@LaunchedEffect

        withContext(Dispatchers.IO) {
            try {
                Log.d("StreamPi", "Auto-discovery: Fetching config from Firebase...")
                val fbRetrofit = Retrofit.Builder()
                    .baseUrl("https://aks-streampi-default-rtdb.asia-southeast1.firebasedatabase.app/")
                    .client(fastClient)
                    .addConverterFactory(GsonConverterFactory.create())
                    .build()
                val fbApi = fbRetrofit.create(FirebaseApiService::class.java)
                val config = fbApi.getConfig()

                Log.d("StreamPi", "Auto-discovery: Got Config -> IP: ${config.ip}, Port: ${config.port}")

                if (!config.ip.isNullOrEmpty()) {
                    withContext(Dispatchers.Main) {
                        statusMessage = "Found ${config.ip}. Connecting..."
                        ip = config.ip
                        port = config.port?.toString() ?: "3005"
                    }

                    val discoveredUrl = config.url ?: "http://${config.ip}:${config.port}"

                    testConnection(
                        url = discoveredUrl,
                        onSuccess = { onSave(discoveredUrl) },
                        onError = { err ->
                            Log.w("StreamPi", "Auto-discovery connection failed: $err")
                            isAutoDiscovering = false
                            errorMsg = "Found ${config.ip} but failed to connect ($err)"
                        }
                    )
                } else {
                    withContext(Dispatchers.Main) {
                        isAutoDiscovering = false
                        errorMsg = "No server config found in database."
                    }
                }
            } catch (e: Exception) {
                Log.e("StreamPi", "Auto-discovery error", e)
                withContext(Dispatchers.Main) {
                    isAutoDiscovering = false
                }
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(Tokens.bg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Icon(Icons.Default.PlayArrow, contentDescription = null, tint = Tokens.accent, modifier = Modifier.size(60.dp))
        Text("StreamPi", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(30.dp))

        if (isAutoDiscovering) {
            CircularProgressIndicator(color = Tokens.accent, modifier = Modifier.size(40.dp))
            Spacer(modifier = Modifier.height(20.dp))
            Text(statusMessage, color = Color.Gray)
            Spacer(modifier = Modifier.height(30.dp))

            FocusableItem(
                onClick = { isAutoDiscovering = false },
                modifier = Modifier.width(200.dp).height(50.dp).focusRequester(manualBtnRef)
            ) {
                Box(Modifier.fillMaxSize().background(Tokens.surface2), contentAlignment = Alignment.Center) {
                    Text("Enter Manually", color = Color.White)
                }
            }
        } else {
            Text("Connect to Server", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            Spacer(modifier = Modifier.height(20.dp))

            OutlinedTextField(
                value = ip,
                onValueChange = { ip = it },
                label = { Text("IP Address") },
                modifier = Modifier.width(400.dp).focusRequester(ipRef),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color.Red,
                    unfocusedBorderColor = Color.Gray,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                ),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Next)
            )

            Spacer(modifier = Modifier.height(10.dp))

            OutlinedTextField(
                value = port,
                onValueChange = { port = it },
                label = { Text("Port") },
                modifier = Modifier.width(400.dp).focusRequester(portRef),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color.Red,
                    unfocusedBorderColor = Color.Gray,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                ),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done)
            )

            Spacer(modifier = Modifier.height(20.dp))

            if (errorMsg != null) {
                Text(errorMsg!!, color = Color.Red, modifier = Modifier.padding(bottom = 10.dp))
            }

            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                FocusableItem(
                    onClick = {
                        isAutoDiscovering = true
                        errorMsg = null
                    },
                    modifier = Modifier.width(50.dp).height(50.dp)
                ) {
                    Box(Modifier.fillMaxSize().background(Tokens.surface2), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Refresh, contentDescription = "Retry Auto", tint = Color.White)
                    }
                }

                FocusableItem(
                    onClick = {
                        if(ip.isBlank()) {
                            errorMsg = "Enter IP Address"
                            return@FocusableItem
                        }
                        isLoading = true
                        errorMsg = null

                        testConnection(
                            url = "http://$ip:$port",
                            onSuccess = { onSave("http://$ip:$port") },
                            onError = {
                                isLoading = false
                                errorMsg = "Connection failed."
                            }
                        )
                    },
                    modifier = Modifier.width(150.dp).height(50.dp).focusRequester(btnRef)
                ) {
                    Box(Modifier.fillMaxSize().background(Color.White), contentAlignment = Alignment.Center) {
                        if (isLoading) CircularProgressIndicator(modifier = Modifier.size(24.dp), color = Color.Black)
                        else Text("Connect", fontWeight = FontWeight.Bold, color = Color.Black)
                    }
                }
            }
        }
    }
}
