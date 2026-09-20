# @cynosure-mcp/media-file-converter

MCP server for converting images, audio, and video files between formats using ffmpeg.

## Installation

```bash
npx @cynosure-mcp/media-file-converter
```

Or install globally:

```bash
npm install -g @cynosure-mcp/media-file-converter
media-file-converter
```

### Prerequisites

No system FFmpeg installation is required. The server uses its bundled [FFmpeg](https://ffmpeg.org/) binary.

## Tools

| Tool             | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `convert_media`  | Convert a media file with optional quality, resolution, bitrate, and fps settings |
| `get_media_info` | Probe a file and return metadata (codec, duration, resolution, etc.)              |
| `extract_audio`  | Extract audio track from a video file                                             |
| `run_ffmpeg`     | Run custom arguments with the bundled ffmpeg binary                              |

### Custom FFmpeg Commands

Use `run_ffmpeg` when the higher-level tools do not expose an FFmpeg option you need. Supply every argument after `ffmpeg` as a separate array item:

```json
{
  "arguments": ["-y", "-i", "/media/input.mp4", "-vf", "hflip", "/media/output.mp4"],
  "working_directory": "/media",
  "timeout_seconds": 600
}
```

The bundled FFmpeg binary is invoked directly without a shell or interactive input. Relative paths are resolved from `working_directory` (or the MCP server's current directory), and overwrite flags such as `-y` must be supplied explicitly. The tool returns the exit code and captured stdout/stderr.

### Supported Formats

| Type  | Formats                                         |
| ----- | ----------------------------------------------- |
| Image | png, jpg, jpeg, webp, bmp, tiff, gif, ico, avif |
| Audio | mp3, wav, ogg, flac, aac, m4a, wma, opus        |
| Video | mp4, mkv, webm, avi, mov, flv, wmv, gif, ts     |

## Configuration

No configuration required.

## MCP Config

```json
{
  "mcpServers": {
    "media-file-converter": {
      "command": "npx",
      "args": ["@cynosure-mcp/media-file-converter"]
    }
  }
}
```

## License

MIT
