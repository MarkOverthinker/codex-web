import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val previewSigningFile = rootProject.file(
    providers.environmentVariable("CODEX_ANDROID_SIGNING_PROPERTIES").orElse("preview-signing.properties").get()
)
val previewSigningProperties = Properties().apply {
    if (previewSigningFile.isFile) previewSigningFile.inputStream().use { load(it) }
}

android {
    namespace = "app.codexweb.mobile"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.codexweb.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 11
        versionName = "0.4.2"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("preview") {
            previewSigningProperties.getProperty("storeFile")?.let { storeFile = rootProject.file(it) }
            storePassword = previewSigningProperties.getProperty("storePassword")
            keyAlias = previewSigningProperties.getProperty("keyAlias")
            keyPassword = previewSigningProperties.getProperty("keyPassword")
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-preview"
        }
        release {
            isMinifyEnabled = false
        }
        create("preview") {
            initWith(getByName("release"))
            applicationIdSuffix = ".preview"
            versionNameSuffix = "-preview"
            signingConfig = signingConfigs.getByName("preview")
            matchingFallbacks += listOf("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

tasks.matching { it.name == "prePreviewBuild" }.configureEach {
    doFirst {
        check(previewSigningFile.isFile) {
            "Preview requires a persistent signing key: see docs/ANDROID.md; debug signing is not a fallback."
        }
        check(listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all {
            !previewSigningProperties.getProperty(it).isNullOrBlank()
        }) { "Preview signing properties are incomplete." }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")
    implementation("io.noties.markwon:ext-strikethrough:4.6.2")
    implementation("io.noties.markwon:ext-latex:4.6.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.10.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
