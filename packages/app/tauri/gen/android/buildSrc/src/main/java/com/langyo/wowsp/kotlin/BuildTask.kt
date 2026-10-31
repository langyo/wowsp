import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """cargo""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            // Must stay in lockstep with scripts/android_cargo_target.py: the
            // Android NDK's lld cannot open non-ASCII paths (GBK-mangled
            // rustc target paths under a Chinese checkout), so Android Studio
            // builds also need an ASCII CARGO_TARGET_DIR.
            environment("CARGO_TARGET_DIR", androidCargoTargetDir())
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }

    private fun androidCargoTargetDir(): String {
        // Mirrors scripts/android_cargo_target.py (same candidate order and
        // ASCII guard) so the justfile build and Android Studio cannot drift.
        // Convergence contract (2026-10-31): when the shared facility
        // (celestia-devtools mobile build wowsp-android) drives a build it
        // exports WOWSP_ANDROID_CARGO_TARGET, which this resolver honors
        // first — driven builds and standalone builds then agree on one
        // directory by construction.
        val candidates = mutableListOf<String>()
        val override = System.getenv("WOWSP_ANDROID_CARGO_TARGET")?.trim().orEmpty()
        if (override.isNotEmpty()) candidates.add(override)
        val localAppData = System.getenv("LOCALAPPDATA")?.trim().orEmpty()
        if (localAppData.isNotEmpty()) {
            candidates.add(File(localAppData, "wowsp/android-target").path)
        }
        val temp = System.getProperty("java.io.tmpdir")?.trim().orEmpty()
        if (temp.isNotEmpty()) candidates.add(File(temp, "wowsp-android-target").path)
        if (Os.isFamily(Os.FAMILY_WINDOWS)) {
            candidates.add("C:\\Users\\Public\\wowsp-android-target")
        } else {
            candidates.add("/tmp/wowsp-android-target")
        }
        for (candidate in candidates) {
            if (candidate.any { it.code > 0x7E }) continue
            val directory = File(candidate)
            if (directory.isDirectory || directory.mkdirs()) return directory.path
        }
        throw GradleException(
            "No ASCII-writable CARGO_TARGET_DIR for the Android build. " +
                "Set WOWSP_ANDROID_CARGO_TARGET to an ASCII path " +
                "(the NDK lld cannot handle non-ASCII paths)."
        )
    }
}