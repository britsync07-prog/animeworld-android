import { useEffect, useRef } from 'react';
import { apiGet } from '../api';
import { pickTracks, buildCombinedMaster } from './Modal';

declare const Hls: any;

interface Props {
  poster?: string;
  videoSource: string;
  title?: string;
  id?: string;
  raw?: boolean;
  onDownload?: (rec: {
    id: string;
    title: string;
    poster?: string;
    masterRaw: string;
    videoUri: string;
    videoBandwidth: number;
    videoCodecs?: string;
    audio: { lang: string; name: string; uri: string }[];
    combinedMaster: string;
    qualityLabel: string;
  }) => void;
}

export default function Player({
  poster,
  videoSource,
  title,
  id,
  raw = true,
  onDownload,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const proxied = raw
      ? '/api/v1/hls?url=' + encodeURIComponent(videoSource)
      : videoSource;
    let hls: any;
    if (typeof Hls !== 'undefined' && Hls.isSupported) {
      if ((window as any).hls) {
        try { (window as any).hls.destroy(); } catch (_) {}
      }
      hls = new Hls({ maxBufferLength: 30, capLevelToPlayerSize: true });
      (window as any).hls = hls;
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e: any, d: any) => {
        if (d && d.fatal) {
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = proxied;
    } else {
      video.src = proxied;
    }
    return () => {
      if (hls) {
        try { hls.destroy(); } catch (_) {}
      }
    };
  }, [videoSource, raw]);

  const enterFullscreen = () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (v.requestFullscreen) v.requestFullscreen();
      else if ((v as any).webkitEnterFullscreen) (v as any).webkitEnterFullscreen();
    } catch (_) {}
  };

  const handleExternal = async () => {
    try {
      const tracks = await apiGet<{ audio: any[]; video: any[] }>(
        '/api/v1/tracks?url=' + encodeURIComponent(videoSource)
      );
      const pick = await pickTracks(tracks, { audioOnly: true });
      if (!pick) return;
      const url =
        '/api/v1/ext_url?url=' +
        encodeURIComponent(videoSource) +
        '&audio=' +
        encodeURIComponent(pick.lang || '');
      const j = await (await fetch(url)).json();
      if ((window as any).AnimeBridge?.openExternal) {
        (window as any).AnimeBridge.openExternal(j.url);
      } else {
        location.href = j.url;
      }
    } catch (e) {
      alert('Could not open external player: ' + (e as Error).message);
    }
  };

  const handleDownload = async () => {
    if (!onDownload || !id) return;
    try {
      const tracks = await apiGet<{ audio: any[]; video: any[] }>(
        '/api/v1/tracks?url=' + encodeURIComponent(videoSource)
      );
      const pick = await pickTracks(tracks, { allowAll: true });
      if (!pick) return;
      const audios = pick.all
        ? tracks.audio
        : tracks.audio.filter((a: any) => a.lang === pick.lang);
      const rec = {
        id,
        title: title || 'Video',
        poster,
        masterRaw: videoSource,
        videoUri: pick.video.uri,
        videoBandwidth: pick.video.bandwidth,
        videoCodecs: pick.video.codecs,
        audio: audios.map((a: any) => ({ lang: a.lang, name: a.name, uri: a.uri })),
        combinedMaster: buildCombinedMaster(pick.video, audios),
        qualityLabel: pick.video
          ? Math.round(pick.video.bandwidth / 1000) + ' kb/s'
          : '',
      };
      onDownload(rec);
    } catch (e) {
      alert('Could not start download: ' + (e as Error).message);
    }
  };

  return (
    <>
      <div className="player">
        <video ref={videoRef} playsInline controls poster={poster || ''} />
      </div>
      <div className="dl-bar">
        <button className="btn" onClick={handleDownload}>
          ⤓ Download
        </button>
        <button className="btn" onClick={enterFullscreen}>
          ⛶ Fullscreen
        </button>
        <button className="btn" onClick={handleExternal}>
          ▶ External player
        </button>
      </div>
    </>
  );
}
