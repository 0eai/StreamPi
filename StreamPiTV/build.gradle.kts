// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

/**
 * Increments versionCode in version.properties, preserving the file's comments.
 *
 *     ./gradlew bumpVersionCode
 *
 * Must be a separate Gradle invocation from the build that consumes it: the app module
 * reads version.properties while configuring, which happens before any task runs, so a
 * bump and an assemble in one command would still package the old number. deploy-apk.sh
 * sequences this correctly.
 */
tasks.register("bumpVersionCode") {
    group = "versioning"
    description = "Increment versionCode in version.properties"
    doLast {
        val f = rootProject.file("version.properties")
        require(f.exists()) { "version.properties not found at ${f.absolutePath}" }

        var found = false
        val lines = f.readLines().map { line ->
            val m = Regex("^(\\s*versionCode\\s*=\\s*)(\\d+)\\s*$").find(line)
            if (m == null) line else {
                found = true
                val next = m.groupValues[2].toInt() + 1
                logger.lifecycle("versionCode ${m.groupValues[2]} -> $next")
                "${m.groupValues[1]}$next"
            }
        }
        require(found) { "no versionCode=<int> line in ${f.name}" }
        f.writeText(lines.joinToString(System.lineSeparator(), postfix = System.lineSeparator()))
    }
}
