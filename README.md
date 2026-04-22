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

Requires [ffmpeg](https://ffmpeg.org/) installed and available on your PATH.

## Tools

| Tool             | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `convert_media`  | Convert a media file with optional quality, resolution, bitrate, and fps settings |
| `get_media_info` | Probe a file and return metadata (codec, duration, resolution, etc.)              |
| `extract_audio`  | Extract audio track from a video file                                             |

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
