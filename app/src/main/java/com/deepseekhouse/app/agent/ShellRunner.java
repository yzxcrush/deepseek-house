package com.deepseekhouse.app.agent;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Shell 执行器（SPEC N1 run_shell）。
 *
 * <p>{@code ProcessBuilder("/system/bin/sh", "-c", command)}，cwd = 工作区，
 * stdout + stderr 合并读取，30 秒超时后 destroy（API 26+ 用反射调用 destroyForcibly
 * 作为兜底，避免 minSdk 24 上直接引用新 API），输出最多保留 64KB。</p>
 *
 * <p>只应在后台线程调用：内部会阻塞等待进程结束。</p>
 */
public final class ShellRunner {

    public static final String SHELL = "/system/bin/sh";
    public static final long TIMEOUT_MS = 30 * 1000L;
    public static final int MAX_OUTPUT_BYTES = 64 * 1024;

    /** 一次 shell 执行结果。 */
    public static final class Result {
        public final int exitCode;
        public final String output;
        public final boolean timedOut;
        public final boolean outputTruncated;

        Result(int exitCode, String output, boolean timedOut, boolean outputTruncated) {
            this.exitCode = exitCode;
            this.output = output == null ? "" : output;
            this.timedOut = timedOut;
            this.outputTruncated = outputTruncated;
        }
    }

    /** 在 {@code cwd} 下执行命令；任何内部异常都转成 exitCode=-1 的结果，不抛出。 */
    public Result run(String command, File cwd) {
        String cmd = command == null ? "" : command;
        if (cmd.trim().isEmpty()) {
            return new Result(-1, "命令为空", false, false);
        }
        File workingDir = cwd;
        if (workingDir == null || !workingDir.isDirectory()) {
            workingDir = new File("/");
        }
        Process process = null;
        final ByteArrayOutputStream captured = new ByteArrayOutputStream();
        final boolean[] truncated = new boolean[]{false};
        Thread reader = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(SHELL, "-c", cmd);
            builder.directory(workingDir);
            builder.redirectErrorStream(true);
            Map<String, String> env = builder.environment();
            env.put("HOME", workingDir.getAbsolutePath());
            env.put("PWD", workingDir.getAbsolutePath());
            env.put("TERM", "dumb");
            process = builder.start();

            final Process running = process;
            reader = new Thread(new Runnable() {
                @Override
                public void run() {
                    InputStream in = null;
                    try {
                        in = running.getInputStream();
                        byte[] buffer = new byte[8192];
                        int n;
                        while ((n = in.read(buffer)) >= 0) {
                            if (captured.size() < MAX_OUTPUT_BYTES) {
                                int take = Math.min(n, MAX_OUTPUT_BYTES - captured.size());
                                captured.write(buffer, 0, take);
                                if (take < n) {
                                    truncated[0] = true;
                                }
                            } else {
                                truncated[0] = true;
                                // 继续 drain，避免子进程写满管道被阻塞
                            }
                        }
                    } catch (Throwable ignored) {
                        // 进程被 kill 时 read 会抛异常，属正常路径
                    } finally {
                        if (in != null) {
                            try {
                                in.close();
                            } catch (IOException ignored) {
                                // 忽略
                            }
                        }
                    }
                }
            }, "dsh-shell-reader");
            reader.setDaemon(true);
            reader.start();

            long deadline = System.currentTimeMillis() + TIMEOUT_MS;
            boolean finished = false;
            while (System.currentTimeMillis() < deadline) {
                try {
                    process.exitValue();
                    finished = true;
                    break;
                } catch (IllegalThreadStateException stillRunning) {
                    try {
                        Thread.sleep(40L);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }

            boolean timedOut = false;
            int exitCode;
            if (!finished) {
                timedOut = true;
                kill(process);
                exitCode = -1;
            } else {
                exitCode = process.exitValue();
            }
            joinQuietly(reader, 3000L);
            String output = new String(captured.toByteArray(), StandardCharsets.UTF_8);
            return new Result(exitCode, output, timedOut, truncated[0]);
        } catch (Throwable t) {
            if (process != null) {
                kill(process);
            }
            joinQuietly(reader, 1000L);
            return new Result(-1, "无法执行命令：" + describe(t), false, false);
        }
    }

    private static void kill(Process process) {
        if (process == null) {
            return;
        }
        try {
            process.destroy();
        } catch (Throwable ignored) {
            // 忽略
        }
        // destroy() 只发 SIGTERM；个别子进程不响应时用 destroyForcibly（API 26+）
        try {
            Thread.sleep(120L);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        boolean alive;
        try {
            process.exitValue();
            alive = false;
        } catch (IllegalThreadStateException e) {
            alive = true;
        } catch (Throwable t) {
            alive = false;
        }
        if (!alive) {
            return;
        }
        try {
            Process.class.getMethod("destroyForcibly").invoke(process);
        } catch (Throwable ignored) {
            // API < 26 或反射受限：再发一次 SIGTERM 兜底
            try {
                process.destroy();
            } catch (Throwable ignored2) {
                // 忽略
            }
        }
    }

    private static void joinQuietly(Thread thread, long millis) {
        if (thread == null) {
            return;
        }
        try {
            thread.join(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty() ? t.getClass().getSimpleName() : message;
    }
}
