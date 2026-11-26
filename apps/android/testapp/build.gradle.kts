plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.etherpk.testapp"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "com.etherpk.testapp"
        minSdk = 30
        targetSdk = 36
        versionName = "1"
        versionCode = 1
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
