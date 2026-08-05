import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // NEW: Required for Kotlin 2.0+
    id("org.jetbrains.kotlin.plugin.compose")
}

/** Reads a properties file from the project root, or returns null when it is absent. */
fun loadProps(name: String): Properties? {
    val f = rootProject.file(name)
    if (!f.exists()) return null
    return Properties().apply { FileInputStream(f).use { load(it) } }
}

// Versioning lives in version.properties so it can be bumped without editing this file.
// Read at configuration time — see the note there about bump-then-build ordering.
val versionProps = loadProps("version.properties")
val appVersionCode = versionProps?.getProperty("versionCode")?.toIntOrNull() ?: 1
val appVersionName = versionProps?.getProperty("versionName") ?: "1.0"

// Release signing material, deliberately outside version control. Absent on a fresh
// clone, in which case release builds fall back to being unsigned rather than failing
// the whole configuration phase.
val keystoreProps = loadProps("keystore.properties")

android {
    namespace = "com.example.streampitv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.streampitv"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName

        vectorDrawables {
            useSupportLibrary = true
        }
    }

    signingConfigs {
        if (keystoreProps != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Signed with the long-lived key so each build can update the last one in
            // place. Without it Android rejects the install as a signature change.
            signingConfig = signingConfigs.findByName("release")
            // Left off on purpose: the Gson models are mapped by field name, so R8 would
            // need keep rules before this can be turned on safely.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
        // Fixes "This API is experimental" for FocusRequester.createRefs()
        freeCompilerArgs += listOf("-opt-in=androidx.compose.ui.ExperimentalComposeUiApi")
    }
    buildFeatures {
        compose = true
    }
    // REMOVED: composeOptions { kotlinCompilerExtensionVersion = ... } is NOT needed in Kotlin 2.0

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Core Android & Compose
    // Updated to June 2024 BOM for better Kotlin 2.0 compatibility
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.1")

    // NEW: Fixes "Unresolved reference 'compose'" for viewModel()
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.1")

    // Updated activity-compose to match the newer BOM
    implementation("androidx.activity:activity-compose:1.9.0")

    // UI Components
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Networking (Retrofit)
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Async Image Loading (Coil)
    implementation("io.coil-kt:coil-compose:2.6.0")

    // Video Player (Media3 / ExoPlayer)
    implementation("androidx.media3:media3-exoplayer:1.3.0")
    implementation("androidx.media3:media3-ui:1.3.0")
    implementation("androidx.media3:media3-common:1.3.0")

    // Storage (DataStore)
    implementation("androidx.datastore:datastore-preferences:1.0.0")

    // QR generation for kunji discoverable login. The TV cannot run kunji's hosted rp.js
    // widget, so the app builds the same v2 payload itself and renders it as a QR code.
    implementation("com.google.zxing:core:3.5.3")

    // Tests. JUnit was missing entirely, so even the generated ExampleUnitTest could not
    // compile; the kunji QR encoder is pinned by a JVM test, so it is needed now.
    testImplementation("junit:junit:4.13.2")

    // Debugging
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}