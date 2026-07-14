export type Sound = {
  id: string;
  title: string;
  file_url: string;
  image_url: string | null;
  hotkey: string | null;
  order: number;
  created_at: string;
};

export type Soundboard = {
  id: string;
  owner_id: string | null;
  title: string;
  image_url: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  sounds: Sound[];
};

export type User = {
  id: string;
  email: string;
  created_at: string;
};

export type AuthResponse = {
  access_token: string;
  token_type: "bearer";
  user: User;
};

export type YoutubeSource = {
  source_id: string;
  title: string;
  duration: number;
  audio_url: string;
};

export type YoutubeFrameOption = {
  index: number;
  timestamp: number;
  image_url: string;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const ACCESS_TOKEN_KEY = "soundpad.accessToken";

let accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);

function setAccessToken(token: string | null) {
  accessToken = token;
  if (token) {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
  }
}

function withAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return {
    ...init,
    credentials: "include",
    headers,
  };
}

async function refreshAccessToken() {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    setAccessToken(null);
    throw new Error("Session expired");
  }
  const auth = (await response.json()) as AuthResponse;
  setAccessToken(auth.access_token);
  return auth;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response = await fetch(`${API_BASE}${path}`, withAuth(init));
  if (response.status === 401 && !path.startsWith("/auth/")) {
    await refreshAccessToken();
    response = await fetch(`${API_BASE}${path}`, withAuth(init));
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function register(email: string, password: string) {
  const auth = await request<AuthResponse>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  setAccessToken(auth.access_token);
  return auth;
}

export async function login(email: string, password: string) {
  const auth = await request<AuthResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  setAccessToken(auth.access_token);
  return auth;
}

export async function getCurrentUser() {
  if (!accessToken) {
    const auth = await refreshAccessToken();
    return auth.user;
  }
  try {
    return await request<User>("/auth/me");
  } catch {
    const auth = await refreshAccessToken();
    return auth.user;
  }
}

export async function logout() {
  await request<void>("/auth/logout", { method: "POST" });
  setAccessToken(null);
}

export function createBoard(title: string, imageUrl?: string) {
  return request<Soundboard>("/soundboards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, image_url: imageUrl || undefined }),
  });
}

export function getBoards() {
  return request<Soundboard[]>("/soundboards");
}

export function getBoard(boardId: string) {
  return request<Soundboard>(`/soundboards/${boardId}/manage`);
}

export function getPublicBoard(boardId: string) {
  return request<Soundboard>(`/soundboards/${boardId}`);
}

export function searchPublicBoards(query: string) {
  return request<Soundboard[]>(`/soundboards/public/search?q=${encodeURIComponent(query)}`);
}

export function savePublicBoard(boardId: string) {
  return request<Soundboard>(`/soundboards/${boardId}/save`, {
    method: "POST",
  });
}

export function updateBoard(boardId: string, data: { title?: string; image_url?: string | null; is_public?: boolean }) {
  return request<Soundboard>(`/soundboards/${boardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteBoard(boardId: string) {
  return request<void>(`/soundboards/${boardId}`, {
    method: "DELETE",
  });
}

export function addSoundUrl(
  boardId: string,
  data: { title: string; file_url: string; image_url?: string; hotkey?: string },
) {
  return request<Sound>(`/soundboards/${boardId}/sounds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function uploadSound(boardId: string, data: { title: string; image_url?: string; hotkey?: string; file: File }) {
  const formData = new FormData();
  formData.append("title", data.title);
  if (data.hotkey) {
    formData.append("hotkey", data.hotkey);
  }
  if (data.image_url) {
    formData.append("image_url", data.image_url);
  }
  formData.append("file", data.file);

  return request<Sound>(`/soundboards/${boardId}/sounds/upload`, {
    method: "POST",
    body: formData,
  });
}

export function prepareYoutubeSound(url: string) {
  return request<YoutubeSource>("/youtube/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function generateYoutubeFrames(sourceId: string, start: number, duration: number) {
  return request<{ frames: YoutubeFrameOption[] }>("/youtube/frames", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_id: sourceId, start, duration }),
  });
}

export function clipYoutubeSound(
  boardId: string,
  data: {
    source_id: string;
    title: string;
    start: number;
    duration: number;
    image_url?: string;
    frame_index?: number;
    hotkey?: string;
  },
) {
  return request<Sound>(`/soundboards/${boardId}/sounds/youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function copySound(boardId: string, sourceSoundId: string) {
  return request<Sound>(`/soundboards/${boardId}/sounds/copy/${sourceSoundId}`, {
    method: "POST",
  });
}

export function updateSound(
  boardId: string,
  soundId: string,
  data: { title?: string; file_url?: string; image_url?: string | null; hotkey?: string | null },
) {
  return request<Sound>(`/soundboards/${boardId}/sounds/${soundId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteSound(boardId: string, soundId: string) {
  return request<void>(`/soundboards/${boardId}/sounds/${soundId}`, {
    method: "DELETE",
  });
}

export function reorderSounds(boardId: string, soundIds: string[]) {
  return request<Soundboard>(`/soundboards/${boardId}/sounds/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sound_ids: soundIds }),
  });
}
