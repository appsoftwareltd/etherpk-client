import groovy.json.JsonSlurper
import java.security.MessageDigest

plugins {
    alias(libs.plugins.android.application)
}

/** The one version of everything EtherPK releases, read from the Client's package.json. */
val release = (JsonSlurper().parse(rootDir.resolve("../client/package.json")) as Map<*, *>)["version"] as String

/** 1.2.3 is 1002003, so each release is newer than the last. */
val releaseCode = release.substringBefore('-').split('.').map(String::toInt).let { (major, minor, patch) ->
    require(minor < 1000 && patch < 1000) { "Version $release does not fit a version code." }
    major * 1_000_000 + minor * 1_000 + patch
}

/** A build-time setting, from the environment or a -P property. Unset is the empty string: that feature is off. */
fun setting(name: String): String = (System.getenv(name) ?: findProperty(name) as String?).orEmpty()
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val updateKeys: String = rootDir.resolve("../desktop/update-keys.json").let { if (it.isFile) it.readText().replace(Regex("\\s+"), " ").trim() else "[]" }

val keystorePath = setting("ETHERPK_ANDROID_KEYSTORE")

/** The Client's Installed Build, which the APK carries. */
val installedBuildFolder = rootDir.resolve((findProperty("installedBuild") as String?) ?: "../client/build-installed")

/**
 * The account site the Installed Build was made with. A build with no settings file is checked for by
 * the copy below, which every APK needs, so a missing one leaves sign-in off only where nothing is packaged.
 */
val builtIssuer: String = installedBuildFolder.resolve("installed-settings.json").let { file ->
    if (file.isFile) ((JsonSlurper().parse(file) as Map<*, *>)["accountIssuer"] as String?).orEmpty() else ""
}

android {
    namespace = "com.etherpk.app"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "com.etherpk.app"
        minSdk = 30
        targetSdk = 36
        versionName = release
        versionCode = releaseCode
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The account site to sign in to, as the Client's Installed Build was made with it, so the page
        // and the app name one (apps/client/installed-build.ts). Empty leaves sign-in off. Never committed.
        buildConfigField("String", "ACCOUNT_ISSUER", quoted(builtIssuer))
        // Where the signed list of releases is. Empty leaves the update check off.
        buildConfigField("String", "UPDATE_FEED", quoted(setting("INSTALLED_UPDATE_FEED_URL")))
        // The public keys the list may be signed with, shared with the desktop app. None leaves the check off.
        buildConfigField("String", "UPDATE_KEYS", quoted(updateKeys))
    }

    flavorDimensions += "channel"
    productFlavors {
        // Downloaded from the release page. It can ask for All files access.
        create("direct") {
            dimension = "channel"
            buildConfigField("boolean", "ALL_FILES_ACCESS", "true")
            buildConfigField("boolean", "UPDATE_CHECK", "true")
        }
        // For a store, which updates the app itself and does not allow All files access.
        create("play") {
            dimension = "channel"
            buildConfigField("boolean", "ALL_FILES_ACCESS", "false")
            buildConfigField("boolean", "UPDATE_CHECK", "false")
        }
    }

    signingConfigs {
        if (keystorePath.isNotEmpty()) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = setting("ETHERPK_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = setting("ETHERPK_ANDROID_KEY_ALIAS").ifEmpty { "etherpk" }
                keyPassword = setting("ETHERPK_ANDROID_KEY_PASSWORD").ifEmpty { storePassword }
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Null when there is no key: the build then makes an unsigned APK, which no device installs.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The default pattern drops folders whose name starts with an underscore, and the Client's
    // scripts are in _app.
    androidResources { ignoreAssetsPattern = "!.svn:!.git:!.DS_Store" }

    packaging { resources.excludes += listOf("META-INF/**", "org/bouncycastle/**/*.properties", "org/bouncycastle/x509/**", "org/bouncycastle/pqc/**") }

    // The port's contract runs on the JVM and on a device.
    sourceSets {
        getByName("test").kotlin.directories.add("src/sharedTest/kotlin")
        getByName("androidTest").kotlin.directories.add("src/sharedTest/kotlin")
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        // A newer version is a decision (it waits seven days), not a fault of the code.
        disable += listOf("GradleDependency", "AndroidGradlePluginVersion", "NewerVersionAvailable", "OldTargetApi")
    }

    testOptions {
        unitTests.all {
            it.systemProperty("etherpk.repository", rootDir.resolve("../..").path)
            // The JDK's HttpURLConnection drops an Origin header unless told otherwise, and Android's
            // sends it. UrlConnectionHttpTest checks the app's requests carry the one the account site wants.
            it.systemProperty("sun.net.http.allowRestrictedHeaders", "true")
            // Files outside this project the tests compare it with.
            for (path in listOf("packages/native-bridge/src/index.ts", "packages/native-bridge/test-vectors", "apps/client/src/installed-build.test.ts", "apps/android/app/src/main/res/raw/port.js")) {
                it.inputs.files(rootDir.resolve("../..").resolve(path)).withPathSensitivity(PathSensitivity.RELATIVE)
            }
            it.environment("ANDROID_FUZZ_RUNS", System.getenv("ANDROID_FUZZ_RUNS") ?: "300")
        }
    }
}

dependencies {
    implementation(libs.webkit)
    implementation(libs.browser)
    implementation(libs.activity)
    implementation(libs.core)
    implementation(libs.bouncycastle)
    testImplementation(libs.junit)
    // The platform's own org.json is a stub on the JVM.
    testImplementation(libs.json)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.ext)
    androidTestImplementation(libs.uiautomator)
}

/** The Client as static files, copied into the APK's assets as they are, with compressed copies left out. */
abstract class CopyInstalledBuild : DefaultTask() {
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val from: DirectoryProperty
    @get:OutputDirectory abstract val into: DirectoryProperty
    @get:Inject abstract val files: FileSystemOperations

    @TaskAction fun copy() {
        files.sync {
            from(this@CopyInstalledBuild.from) {
                exclude("**/*.br", "**/*.gz", "**/*.map")
                into("installed")
            }
            into(this@CopyInstalledBuild.into)
        }
    }
}

val copyInstalledBuild = tasks.register<CopyInstalledBuild>("copyInstalledBuild") {
    val folder = installedBuildFolder
    from = folder
    into = layout.buildDirectory.dir("installedBuild")
    doFirst {
        if (!folder.resolve("index.html").isFile || !folder.resolve("csp.txt").isFile || !folder.resolve("installed-settings.json").isFile) {
            throw GradleException("There is no Installed Build in $folder. Run: pnpm --filter @appsoftwareltd/etherpk-client build:installed")
        }
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyInstalledBuild, CopyInstalledBuild::into)
    }
}

/** `packageRelease`: the file a person downloads, in build/release, named as every release names it. */
tasks.register<Copy>("packageRelease") {
    group = "distribution"
    description = "Builds the signed release APK as build/release/EtherPK-android.apk, with its SHA-256."
    dependsOn("assembleDirectRelease")
    val signed = keystorePath.isNotEmpty()
    doFirst { if (!signed) throw GradleException("No signing key. Set ETHERPK_ANDROID_KEYSTORE (see apps/android/SIGNING.md).") }
    from(layout.buildDirectory.dir("outputs/apk/direct/release")) { include("*-release.apk") }
    into(rootDir.resolve("build/release"))
    rename { "EtherPK-android.apk" }
    val apk = rootDir.resolve("build/release/EtherPK-android.apk")
    doLast {
        val digest = MessageDigest.getInstance("SHA-256").digest(apk.readBytes()).joinToString("") { "%02x".format(it) }
        apk.resolveSibling("EtherPK-android.apk.sha256").writeText("$digest  EtherPK-android.apk\n")
    }
}

// The other app the tests on a device use.
tasks.matching { it.name.startsWith("connected") && it.name.endsWith("AndroidTest") }.configureEach { dependsOn(":testapp:installDebug") }
