import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Mic, RotateCcw, AlertCircle } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';

export interface VoiceNotePlayerProps {
  src: string;
  mimeType?: string;
  isOutbound?: boolean;
}

const PLAYBACK_RATES = [1, 1.5, 2] as const;

export const VoiceNotePlayer: React.FC<VoiceNotePlayerProps> = ({
  src,
  mimeType = 'audio/ogg',
  isOutbound = false,
}) => {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);
  const [hasBeenPlayed, setHasBeenPlayed] = useState(isOutbound);
  const [audioError, setAudioError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // Generate pseudo-waveform bars with deterministic heights
  const bars = React.useMemo(() => {
    return [30, 60, 45, 80, 55, 90, 70, 40, 65, 85, 50, 75, 95, 60, 40, 70, 85, 45, 65, 90, 50, 35];
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    setAudioError(false);

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.currentTime > 0) setHasBeenPlayed(true);
      if (!Number.isFinite(duration) || duration <= 0) {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setDuration(audio.duration);
        }
      }
    };
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      setHasBeenPlayed(true);
    };
    const onPlay = () => {
      setIsPlaying(true);
      setHasBeenPlayed(true);
    };
    const onPause = () => setIsPlaying(false);
    const onError = () => {
      if (audio.error && audio.error.code === 1) {
        // MEDIA_ERR_ABORTED - normal during range probe or chunk transition
        return;
      }
      setAudioError(true);
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
    };
  }, [src, retryKey, duration]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((err) => {
        console.error('[VoiceNotePlayer] play error:', err);
        setAudioError(true);
      });
    }
  }, [isPlaying]);

  const cycleRate = useCallback(() => {
    const nextIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(nextIndex);
    const newRate = PLAYBACK_RATES[nextIndex];
    if (audioRef.current) {
      audioRef.current.playbackRate = newRate;
    }
  }, [rateIndex]);

  const effectiveDuration = Number.isFinite(duration) && duration > 0 
    ? duration 
    : (audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0 
      ? audioRef.current.duration 
      : 0);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || effectiveDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    audio.currentTime = ratio * effectiveDuration;
    setCurrentTime(audio.currentTime);
  };

  const formatSecs = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = effectiveDuration > 0 ? Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100)) : 0;

  if (audioError) {
    return (
      <div className="flex items-center gap-2.5 py-1 px-1 min-w-[220px] select-none text-rose-500">
        <AlertCircle className="w-5 h-5 shrink-0 opacity-80" />
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300 flex-1 truncate">
          {t('whatsapp.mediaLoadFailed')}
        </span>
        <button
          type="button"
          onClick={() => {
            setAudioError(false);
            setRetryKey((k) => k + 1);
          }}
          className="p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          title={t('whatsapp.mediaRetry')}
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-1 px-1 min-w-[240px] max-w-[280px] select-none">
      <audio key={retryKey} ref={audioRef} src={src} preload="metadata" />

      {/* Play/Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        className={`w-9 h-9 rounded-full ${
          hasBeenPlayed ? 'bg-[#53bdeb] hover:bg-[#3ea9d6]' : 'bg-[#25D366] hover:bg-[#20ba59]'
        } text-white flex items-center justify-center shrink-0 shadow-sm transition-transform active:scale-95 cursor-pointer`}
        aria-label={isPlaying ? t('whatsapp.voicePause') : t('whatsapp.voicePlay')}
      >
        {isPlaying ? (
          <Pause className="w-4 h-4 fill-white" />
        ) : (
          <Play className="w-4 h-4 fill-white ml-0.5" />
        )}
      </button>

      {/* Waveform / Progress Scrub Area */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
        <div
          className="relative h-6 flex items-center gap-[3px] cursor-pointer"
          onClick={handleSeek}
          role="slider"
          aria-valuenow={currentTime}
          aria-valuemin={0}
          aria-valuemax={duration}
          tabIndex={0}
        >
          {bars.map((heightPct, idx) => {
            const barPercent = (idx / bars.length) * 100;
            const isFilled = barPercent <= progressPercent;
            return (
              <span
                key={idx}
                className={`w-[3px] rounded-full transition-colors duration-100 ${
                  isFilled
                    ? hasBeenPlayed
                      ? 'bg-[#53bdeb]'
                      : 'bg-[#25D366]'
                    : isOutbound
                    ? 'bg-emerald-950/25 dark:bg-white/30'
                    : 'bg-slate-300 dark:bg-white/20'
                }`}
                style={{ height: `${heightPct}%` }}
              />
            );
          })}
        </div>

        {/* Time display & Rate toggle */}
        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 font-medium">
          <span>{formatSecs(currentTime > 0 ? currentTime : duration)}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={cycleRate}
              className="px-1.5 py-0.5 rounded-full bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 font-bold text-[9px] transition-colors cursor-pointer"
              title={t('whatsapp.voiceSpeed')}
              aria-label={t('whatsapp.voiceSpeed')}
            >
              {PLAYBACK_RATES[rateIndex]}x
            </button>
            <Mic
              className={`w-3 h-3 transition-colors ${
                hasBeenPlayed ? 'text-[#53bdeb]' : 'text-[#25D366]'
              }`}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

