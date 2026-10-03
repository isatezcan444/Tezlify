import { spawn } from 'node:child_process';
import { logger } from '../utils/baileys-logger.js';

/**
 * Checks if a buffer already starts with the Ogg magic bytes "OggS"
 * and contains Opus audio codec signature ("OpusHead").
 */
export function isOggOpus(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 36) return false;
  if (buffer.subarray(0, 4).toString('ascii') !== 'OggS') return false;
  return buffer.subarray(28, 36).toString('ascii') === 'OpusHead';
}

/**
 * Transcodes any audio buffer (WebM from Chrome/Safari MediaRecorder, MP3, MP4/AAC, WAV, etc.)
 * into authentic WhatsApp-compliant Ogg Opus format:
 * - Codec: libopus
 * - Sample rate: 48000 Hz
 * - Channels: 1 (Mono)
 * - Bitrate: 32kbps
 * - Container: Ogg
 *
 * If ffmpeg is unavailable or fails, gracefully falls back to the original buffer.
 */
export async function transcodeToOggOpus(inputBuffer) {
  if (!inputBuffer || !Buffer.isBuffer(inputBuffer)) {
    return { buffer: inputBuffer, mimetype: 'audio/ogg; codecs=opus' };
  }

  // If already verified Ogg Opus, skip transcoding
  if (isOggOpus(inputBuffer)) {
    return { buffer: inputBuffer, mimetype: 'audio/ogg; codecs=opus' };
  }

  return new Promise((resolve) => {
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '48000',
      '-f', 'ogg',
      'pipe:1',
    ];

    let proc;
    try {
      proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      logger.warn({ err }, '[audio-transcoder] ffmpeg spawn failed, keeping original audio');
      return resolve({ buffer: inputBuffer, mimetype: 'audio/ogg; codecs=opus' });
    }

    const chunks = [];
    const stderrChunks = [];

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    proc.on('error', (err) => {
      logger.warn({ err }, '[audio-transcoder] ffmpeg process error, fallback to original');
      resolve({ buffer: inputBuffer, mimetype: 'audio/ogg; codecs=opus' });
    });

    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        const oggBuffer = Buffer.concat(chunks);
        logger.info(
          { originalSize: inputBuffer.length, oggSize: oggBuffer.length },
          '[audio-transcoder] Successfully transcoded audio to WhatsApp-compliant Ogg Opus'
        );
        resolve({ buffer: oggBuffer, mimetype: 'audio/ogg; codecs=opus' });
      } else {
        const errDetails = Buffer.concat(stderrChunks).toString('utf8');
        logger.warn(
          { code, errDetails },
          '[audio-transcoder] ffmpeg conversion failed, fallback to original audio'
        );
        resolve({ buffer: inputBuffer, mimetype: 'audio/ogg; codecs=opus' });
      }
    });

    // Feed original audio to stdin
    try {
      proc.stdin.write(inputBuffer);
      proc.stdin.end();
    } catch (e) {
      logger.warn({ err: e }, '[audio-transcoder] stdin write error');
      resolve({ buffer: inputBuffer, mimetype: 'audio/ogg; codecs=opus' });
    }
  });
}
