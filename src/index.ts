#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
// @ts-expect-error no type declarations available
import ffprobeStatic from 'ffprobe-static';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

// ── Configure ffmpeg paths ─────────────────────────────────────────────────────

const bundledFfmpegPath = ffmpegPath as unknown as string | null;

if (bundledFfmpegPath) ffmpeg.setFfmpegPath(bundledFfmpegPath);
ffmpeg.setFfprobePath((ffprobeStatic as { path: string }).path);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Supported output formats grouped by media type. */
const SUPPORTED_FORMATS: Record<string, string[]> = {
    image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif', 'ico', 'avif'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'],
    video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'wmv', 'gif', 'ts'],
};

const ALL_FORMATS = [...new Set(Object.values(SUPPORTED_FORMATS).flat())];
const MAX_COMMAND_OUTPUT_LENGTH = 1024 * 1024;

function getMediaType(format: string): 'image' | 'audio' | 'video' | null {
    const f = format.toLowerCase();
    if (SUPPORTED_FORMATS.image.includes(f)) return 'image';
    if (SUPPORTED_FORMATS.audio.includes(f)) return 'audio';
    if (SUPPORTED_FORMATS.video.includes(f)) return 'video';
    return null;
}

/** Resolve and validate that the input file exists. */
async function resolveInputPath(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    try {
        await fs.access(resolved);
    } catch {
        throw new Error(`Input file not found: ${resolved}`);
    }
    return resolved;
}

/** Build the default output path: same directory, same base name, new extension. */
function buildOutputPath(inputPath: string, targetFormat: string, outputDir?: string): string {
    const dir = outputDir || path.dirname(inputPath);
    const baseName = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, `${baseName}.${targetFormat}`);
}

/** Check whether output and input paths point to the same file (case-insensitive on extension, normalized). */
function isSamePath(a: string, b: string): boolean {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** Build a default output path that never collides with the input path. */
function buildSafeOutputPath(inputPath: string, targetFormat: string, outputDir?: string): string {
    const defaultPath = buildOutputPath(inputPath, targetFormat, outputDir);
    if (!isSamePath(defaultPath, inputPath)) return defaultPath;
    // Same-format conversion: avoid overwriting the original by suffixing "-converted"
    const dir = outputDir || path.dirname(inputPath);
    const baseName = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, `${baseName}-converted.${targetFormat}`);
}

/** Probe a media file and return its metadata. */
function probeFile(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            if (err) reject(new Error(`Failed to probe file: ${err.message}`));
            else resolve(data);
        });
    });
}

interface CustomCommandResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
}

/** Append process output while retaining the most recent, diagnostically useful text. */
function appendCommandOutput(current: string, chunk: Buffer): { output: string; truncated: boolean } {
    const combined = current + chunk.toString('utf8');
    if (combined.length <= MAX_COMMAND_OUTPUT_LENGTH) {
        return { output: combined, truncated: false };
    }
    return {
        output: combined.slice(-MAX_COMMAND_OUTPUT_LENGTH),
        truncated: true,
    };
}

/** Run the bundled ffmpeg binary directly, without shell interpretation. */
function runCustomCommand(args: string[], workingDirectory: string, timeoutSeconds: number): Promise<CustomCommandResult> {
    return new Promise((resolve, reject) => {
        if (!bundledFfmpegPath) {
            reject(new Error('The bundled ffmpeg binary is unavailable on this platform.'));
            return;
        }

        const child = spawn(bundledFfmpegPath, args, {
            cwd: workingDirectory,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let outputTruncated = false;
        let timedOut = false;

        child.stdout.on('data', (chunk: Buffer) => {
            const result = appendCommandOutput(stdout, chunk);
            stdout = result.output;
            outputTruncated ||= result.truncated;
        });
        child.stderr.on('data', (chunk: Buffer) => {
            const result = appendCommandOutput(stderr, chunk);
            stderr = result.output;
            outputTruncated ||= result.truncated;
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutSeconds * 1000);

        child.once('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Failed to start ffmpeg: ${err.message}`));
        });
        child.once('close', (exitCode, signal) => {
            clearTimeout(timeout);
            if (timedOut) {
                reject(new Error(`ffmpeg command timed out after ${timeoutSeconds} seconds.${stderr ? `\n${stderr}` : ''}`));
                return;
            }
            resolve({ exitCode, signal, stdout, stderr, outputTruncated });
        });
    });
}

/** Run an ffmpeg conversion and return the output path. */
function runConversion(
    inputPath: string,
    outputPath: string,
    options: {
        targetFormat: string;
        quality?: number;
        width?: number;
        height?: number;
        audioBitrate?: string;
        videoBitrate?: string;
        fps?: number;
    },
): Promise<string> {
    return new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath);
        const mediaType = getMediaType(options.targetFormat);

        // Image-specific options
        if (mediaType === 'image') {
            cmd = cmd.outputOptions('-frames:v', '1');
            if (options.quality !== undefined) {
                // For JPEG/WebP, quality maps to qscale (1=best, 31=worst)
                const qscale = Math.max(1, Math.min(31, Math.round(31 - (options.quality / 100) * 30)));
                cmd = cmd.outputOptions('-qscale:v', String(qscale));
            }
        }

        // Audio-specific options
        if (mediaType === 'audio') {
            if (options.audioBitrate) {
                cmd = cmd.audioBitrate(options.audioBitrate);
            }
        }

        // Video-specific options
        if (mediaType === 'video') {
            if (options.videoBitrate) {
                cmd = cmd.videoBitrate(options.videoBitrate);
            }
            if (options.audioBitrate) {
                cmd = cmd.audioBitrate(options.audioBitrate);
            }
            if (options.fps) {
                cmd = cmd.fps(options.fps);
            }
        }

        // Resize (applies to both image and video)
        if (options.width || options.height) {
            const w = options.width || -2;
            const h = options.height || -2;
            // Use the scale filter: unlike -s, it supports -1/-2 for aspect-ratio-preserving auto-dimension
            // (-2 keeps the dimension even, required by most video codecs)
            cmd = cmd.videoFilters([`scale=${w}:${h}`]);
        }

        // Overwrite existing output
        cmd = cmd.outputOptions('-y');

        cmd
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err: Error) => reject(new Error(`Conversion failed: ${err.message}`)))
            .run();
    });
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'Media File Converter',
    version: '1.0.0',
    title: 'Media File Converter',
    description: 'Convert images, audio, and video files between formats using ffmpeg.',
    icons: [{ src: 'https://unpkg.com/@cynosure-mcp/media-file-converter@1.0.4/icon.png', mimeType: 'image/png' }],
});

// ── Tool: convert_media ────────────────────────────────────────────────────────

server.registerTool(
    'convert_media',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: `Convert a media file (image, audio, or video) to a different format using ffmpeg.
Supported image formats: ${SUPPORTED_FORMATS.image.join(', ')}
Supported audio formats: ${SUPPORTED_FORMATS.audio.join(', ')}
Supported video formats: ${SUPPORTED_FORMATS.video.join(', ')}`,
        inputSchema: {
            input_path: z.string().describe('Absolute path to the source media file'),
            target_format: z
                .string()
                .describe(`Target format extension (e.g. "png", "mp3", "mp4"). Supported: ${ALL_FORMATS.join(', ')}`),
            output_path: z
                .string()
                .optional()
                .describe('Optional custom output path. Defaults to same directory with new extension (suffixed "-converted" if it would collide with the input file). Must differ from input_path'),
            quality: z
                .number()
                .min(1)
                .max(100)
                .optional()
                .describe('Quality 1-100 for image output (100 = best). Only applies to image conversions'),
            width: z.number().positive().optional().describe('Target width in pixels. Aspect ratio preserved if only one dimension set'),
            height: z.number().positive().optional().describe('Target height in pixels. Aspect ratio preserved if only one dimension set'),
            audio_bitrate: z
                .string()
                .optional()
                .describe('Audio bitrate (e.g. "128k", "320k"). Applies to audio and video output'),
            video_bitrate: z
                .string()
                .optional()
                .describe('Video bitrate (e.g. "1000k", "5M"). Applies to video output'),
            fps: z.number().positive().optional().describe('Target frames per second. Applies to video output'),
        },
    },
    async ({
        input_path,
        target_format,
        output_path,
        quality,
        width,
        height,
        audio_bitrate,
        video_bitrate,
        fps,
    }) => {
        try {
            const format = target_format.toLowerCase().replace(/^\./, '');

            if (!ALL_FORMATS.includes(format)) {
                return {
                    content: [{ type: 'text', text: `Unsupported format "${format}". Supported formats: ${ALL_FORMATS.join(', ')}` }],
                    isError: true,
                };
            }

            const resolvedInput = await resolveInputPath(input_path);
            const resolvedOutput = output_path
                ? path.resolve(output_path)
                : buildSafeOutputPath(resolvedInput, format);

            if (isSamePath(resolvedOutput, resolvedInput)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: output path (${resolvedOutput}) must differ from input path (${resolvedInput}). Converting in place would overwrite the original file.`,
                        },
                    ],
                    isError: true,
                };
            }

            // Ensure output directory exists
            await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

            const result = await runConversion(resolvedInput, resolvedOutput, {
                targetFormat: format,
                quality,
                width,
                height,
                audioBitrate: audio_bitrate,
                videoBitrate: video_bitrate,
                fps,
            });

            // Get output file size
            const stats = await fs.stat(result);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully converted file.\nInput: ${resolvedInput}\nOutput: ${result}\nSize: ${sizeMB} MB`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Tool: get_media_info ───────────────────────────────────────────────────────

server.registerTool(
    'get_media_info',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Probe a media file and return its metadata: format, duration, resolution, codecs, bitrate, etc.',
        inputSchema: {
            file_path: z.string().describe('Absolute path to the media file to probe'),
        },
    },
    async ({ file_path }) => {
        try {
            const resolved = await resolveInputPath(file_path);
            const info = await probeFile(resolved);

            const format = info.format;
            const streams = info.streams || [];

            const videoStream = streams.find((s) => s.codec_type === 'video');
            const audioStream = streams.find((s) => s.codec_type === 'audio');

            const summary: Record<string, unknown> = {
                file: resolved,
                format: format.format_long_name || format.format_name,
                duration_seconds: format.duration ? Number(format.duration) : null,
                size_mb: format.size ? (Number(format.size) / (1024 * 1024)).toFixed(2) : null,
                overall_bitrate_kbps: format.bit_rate ? Math.round(Number(format.bit_rate) / 1000) : null,
            };

            if (videoStream) {
                summary.video = {
                    codec: videoStream.codec_long_name || videoStream.codec_name,
                    width: videoStream.width,
                    height: videoStream.height,
                    fps: videoStream.r_frame_rate,
                    bitrate_kbps: videoStream.bit_rate ? Math.round(Number(videoStream.bit_rate) / 1000) : null,
                    pixel_format: videoStream.pix_fmt,
                };
            }

            if (audioStream) {
                summary.audio = {
                    codec: audioStream.codec_long_name || audioStream.codec_name,
                    sample_rate: audioStream.sample_rate,
                    channels: audioStream.channels,
                    bitrate_kbps: audioStream.bit_rate ? Math.round(Number(audioStream.bit_rate) / 1000) : null,
                };
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Tool: extract_audio ────────────────────────────────────────────────────────

server.registerTool(
    'extract_audio',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Extract the audio track from a video file and save it as a separate audio file.',
        inputSchema: {
            input_path: z.string().describe('Absolute path to the video file'),
            output_format: z
                .string()
                .default('mp3')
                .describe(`Output audio format (e.g. "mp3", "wav", "flac"). Supported: ${SUPPORTED_FORMATS.audio.join(', ')}`),
            output_path: z.string().optional().describe('Optional custom output path. Defaults to same directory with audio extension'),
            audio_bitrate: z.string().optional().describe('Audio bitrate (e.g. "128k", "320k")'),
        },
    },
    async ({ input_path, output_format, output_path, audio_bitrate }) => {
        try {
            const format = output_format.toLowerCase().replace(/^\./, '');

            if (!SUPPORTED_FORMATS.audio.includes(format)) {
                return {
                    content: [
                        { type: 'text', text: `Unsupported audio format "${format}". Supported: ${SUPPORTED_FORMATS.audio.join(', ')}` },
                    ],
                    isError: true,
                };
            }

            const resolvedInput = await resolveInputPath(input_path);
            const resolvedOutput = output_path
                ? path.resolve(output_path)
                : buildSafeOutputPath(resolvedInput, format);

            if (isSamePath(resolvedOutput, resolvedInput)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: output path (${resolvedOutput}) must differ from input path (${resolvedInput}).`,
                        },
                    ],
                    isError: true,
                };
            }

            await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

            await new Promise<void>((resolve, reject) => {
                let cmd = ffmpeg(resolvedInput).noVideo().outputOptions('-y');
                if (audio_bitrate) cmd = cmd.audioBitrate(audio_bitrate);

                cmd
                    .output(resolvedOutput)
                    .on('end', () => resolve())
                    .on('error', (err: Error) => reject(new Error(`Audio extraction failed: ${err.message}`)))
                    .run();
            });

            const stats = await fs.stat(resolvedOutput);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully extracted audio.\nInput: ${resolvedInput}\nOutput: ${resolvedOutput}\nFormat: ${format}\nSize: ${sizeMB} MB`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Tool: run_ffmpeg ──────────────────────────────────────────────────────────

server.registerTool(
    'run_ffmpeg',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: `Run a custom command with this server's bundled ffmpeg binary. Pass only the arguments that follow "ffmpeg" as separate array items. The command runs without a shell or interactive stdin. Include options such as "-y" explicitly when needed.`,
        inputSchema: {
            arguments: z
                .array(z.string())
                .min(1)
                .describe('FFmpeg arguments as separate items, for example ["-i", "/input.mp4", "-vn", "/output.mp3"]'),
            working_directory: z
                .string()
                .optional()
                .describe('Working directory used to resolve relative paths. Defaults to the MCP server process directory'),
            timeout_seconds: z
                .number()
                .int()
                .min(1)
                .max(3600)
                .default(300)
                .describe('Maximum command duration in seconds (default 300, maximum 3600)'),
        },
    },
    async ({ arguments: args, working_directory, timeout_seconds }) => {
        try {
            const workingDirectory = path.resolve(working_directory || process.cwd());
            const directoryStats = await fs.stat(workingDirectory);
            if (!directoryStats.isDirectory()) {
                throw new Error(`Working directory is not a directory: ${workingDirectory}`);
            }

            const result = await runCustomCommand(args, workingDirectory, timeout_seconds);
            const sections = [
                `ffmpeg exited with code ${result.exitCode ?? 'null'}${result.signal ? ` (signal: ${result.signal})` : ''}.`,
                `Working directory: ${workingDirectory}`,
            ];
            if (result.outputTruncated) sections.push(`Output was truncated to the last ${MAX_COMMAND_OUTPUT_LENGTH} characters per stream.`);
            if (result.stdout) sections.push(`stdout:\n${result.stdout.trimEnd()}`);
            if (result.stderr) sections.push(`stderr:\n${result.stderr.trimEnd()}`);

            return {
                content: [{ type: 'text', text: sections.join('\n\n') }],
                isError: result.exitCode !== 0,
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Start server ───────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
