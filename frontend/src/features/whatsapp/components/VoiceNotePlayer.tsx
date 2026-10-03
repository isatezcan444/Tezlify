import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Mic } from 'lucide-react';

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  // Generate pseudo-waveform bars with deterministic heights
  const bars = React.useMemo(() => {
    const pattern = [30, 60, 45, 80, 55, 90, 70, 40, 65, 85, 50, 75, 95, 60, 40, 70, 85, 45, 65, 90, 50, 35];
    return pattern;
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((err) => console.error('[VoiceNotePlayer] play error:', err));
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

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  };

  const formatSecs = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3 py-1 px-1 min-w-[240px] max-w-[280px] select-none">
      <audio ref={audioRef} src={src} preload="metadata" />

      {/* Play/Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        className="w-9 h-9 rounded-full bg-[#25D366] hover:bg-[#20ba59] text-white flex items-center justify-center shrink-0 shadow-sm transition-transform active:scale-95 cursor-pointer"
        aria-label={isPlaying ? 'Durdur' : 'Oynat'}
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
                    ? 'bg-[#25D366]'
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
              title="Oynatma Hızı"
            >
              {PLAYBACK_RATES[rateIndex]}x
            </button>
            <Mic className="w-3 h-3 text-[#25D366]" />
          </div>
        </div>
      </div>
    </div>
  );
};
