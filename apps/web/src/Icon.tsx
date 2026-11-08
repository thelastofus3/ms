import type { ReactNode } from "react";

export type IconName = "cube" | "layers" | "eye" | "camera" | "person" | "images" | "users" | "arrow" | "logout" | "upload";

const artwork: Record<IconName, ReactNode> = {
  cube: <><path d="m12 3 9 5v8l-9 5-9-5V8z" /><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" /></>,
  layers: <><path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  camera: <><path d="M9 5 7 8H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-3l-2-3Z" /><circle cx="12" cy="14" r="4" /></>,
  person: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  images: <><rect x="6" y="3" width="15" height="15" rx="2" /><path d="m6 13 4-4 7 9M14 14l3-3 4 4M3 7v12a2 2 0 0 0 2 2h12" /><circle cx="16" cy="7" r="1" /></>,
  users: <><circle cx="9" cy="7" r="3" /><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 4a3 3 0 0 1 0 6M22 21v-3a7 7 0 0 0-4-6" /></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  logout: <><path d="M9 4H4v16h5M9 12h13m-5-5 5 5-5 5" /></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{artwork[name]}</svg>;
}

export function RoomIllustration() {
  return <svg className="room-illustration" viewBox="0 0 280 190" fill="none" aria-hidden="true" focusable="false">
    <path d="m140 20 110 60v70l-110 30-110-60V50z" fill="currentColor" fillOpacity=".025" />
    <g stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="m30 120 110 60 110-60-110-60zM30 120V50l110-30 110 60v40M140 60V20" opacity=".35" /><path d="m65 122 60 32 67-35-60-32zM65 122v-24l60 32v24M125 130l67-35v24M65 98l67-35 60 32M132 63v24" /><path d="m183 63 36 19v31l-36-19zM201 73v31m-18-25 36 19" opacity=".65" /><path d="m45 133 110 60m-15-13 20-11" opacity=".2" /></g>
    <circle cx="140" cy="20" r="3" fill="currentColor" /><circle cx="250" cy="120" r="3" fill="currentColor" /><circle cx="30" cy="120" r="3" fill="currentColor" />
  </svg>;
}
