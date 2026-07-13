import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Layers, Link, Lock, LogOut, Pause, Pencil, Play, Plus, Save, Search, Scissors, Trash2, Upload, UserRound, X, Youtube } from "lucide-react";
import {
  Sound,
  Soundboard,
  User,
  YoutubeSource,
  addSoundUrl,
  clipYoutubeSound,
  copySound,
  createBoard,
  deleteBoard,
  deleteSound,
  getBoard,
  getBoards,
  getCurrentUser,
  getPublicBoard,
  login,
  logout,
  reorderSounds,
  register,
  savePublicBoard,
  searchPublicBoards,
  prepareYoutubeSound,
  updateBoard,
  updateSound,
  uploadSound,
} from "./api";

const LOCAL_BOARD_KEY = "soundpad.currentBoardId";

type AddMode = "upload" | "url" | "youtube";
type AuthMode = "login" | "register";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [publicBoard, setPublicBoard] = useState<Soundboard | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [board, setBoard] = useState<Soundboard | null>(null);
  const [boards, setBoards] = useState<Soundboard[]>([]);
  const [publicSearch, setPublicSearch] = useState("");
  const [publicResults, setPublicResults] = useState<Soundboard[]>([]);
  const [isSearchingPublic, setIsSearchingPublic] = useState(false);
  const [titleDraft, setTitleDraft] = useState("My Soundboard");
  const [boardImageDraft, setBoardImageDraft] = useState("");
  const [soundTitle, setSoundTitle] = useState("");
  const [soundUrl, setSoundUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeSource, setYoutubeSource] = useState<YoutubeSource | null>(null);
  const [clipStart, setClipStart] = useState(0);
  const [clipDuration, setClipDuration] = useState(8);
  const [isPreparingYoutube, setIsPreparingYoutube] = useState(false);
  const [isPreviewingClip, setIsPreviewingClip] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [hotkey, setHotkey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<AddMode>("upload");
  const [isAddPanelOpen, setIsAddPanelOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingSound, setEditingSound] = useState<Sound | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editAudioUrl, setEditAudioUrl] = useState("");
  const [editImageUrl, setEditImageUrl] = useState("");
  const [editHotkey, setEditHotkey] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteBoardId, setConfirmDeleteBoardId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const youtubePreviewRef = useRef<HTMLAudioElement | null>(null);
  const youtubePreviewTimerRef = useRef<number | null>(null);
  const playingIdRef = useRef<string | null>(null);

  const sortedSounds = useMemo(() => [...(board?.sounds ?? [])].sort((a, b) => a.order - b.order), [board]);
  const librarySounds = useMemo(
    () =>
      boards
        .filter((item) => item.id !== board?.id)
        .flatMap((item) =>
          [...item.sounds]
            .sort((a, b) => a.order - b.order)
            .map((sound) => ({
              ...sound,
              boardTitle: item.title,
            })),
        ),
    [board?.id, boards],
  );

  const loadBoard = useCallback(async (boardId: string) => {
    const nextBoard = await getBoard(boardId);
    setBoard(nextBoard);
    setTitleDraft(nextBoard.title);
    setBoardImageDraft(nextBoard.image_url ?? "");
    localStorage.setItem(LOCAL_BOARD_KEY, nextBoard.id);
    window.history.replaceState(null, "", `?board=${nextBoard.id}`);
  }, []);

  const refreshBoards = useCallback(async () => {
    const nextBoards = await getBoards();
    setBoards(nextBoards);
    return nextBoards;
  }, []);

  useEffect(() => {
    const checkSession = async () => {
      try {
        setUser(await getCurrentUser());
      } catch {
        const sharedBoardId = new URLSearchParams(window.location.search).get("board");
        if (sharedBoardId) {
          setPublicBoard(await getPublicBoard(sharedBoardId).catch(() => null));
        }
        setUser(null);
      } finally {
        setIsCheckingSession(false);
      }
    };

    checkSession();
  }, []);

  useEffect(() => {
    if (!user) {
      setBoard(null);
      setBoards([]);
      return;
    }

    const boot = async () => {
      const nextBoards = await refreshBoards();
      const requestedBoardId =
        new URLSearchParams(window.location.search).get("board") ?? localStorage.getItem(LOCAL_BOARD_KEY);
      const fallbackBoardId = nextBoards[0]?.id;
      const boardId = requestedBoardId ?? fallbackBoardId;
      if (boardId) {
        await loadBoard(boardId).catch(async () => {
          const sharedBoard = requestedBoardId ? await getPublicBoard(requestedBoardId).catch(() => null) : null;
          if (sharedBoard) {
            setPublicBoard(sharedBoard);
            setBoard(null);
          } else if (fallbackBoardId && fallbackBoardId !== boardId) {
            await loadBoard(fallbackBoardId);
          } else {
            localStorage.removeItem(LOCAL_BOARD_KEY);
          }
        });
      }
    };

    boot().catch(() => setStatus("Could not load boards. Check that the backend is running."));
  }, [loadBoard, refreshBoards, user]);

  useEffect(() => {
    if (!confirmDeleteId) {
      return;
    }
    const timeoutId = window.setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [confirmDeleteId]);

  useEffect(() => {
    if (!confirmDeleteBoardId) {
      return;
    }
    const timeoutId = window.setTimeout(() => setConfirmDeleteBoardId(null), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [confirmDeleteBoardId]);

  useEffect(() => {
    return () => {
      if (youtubePreviewTimerRef.current) {
        window.clearTimeout(youtubePreviewTimerRef.current);
      }
      youtubePreviewRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    const query = publicSearch.trim();
    if (query.length < 2) {
      setPublicResults([]);
      setIsSearchingPublic(false);
      return;
    }

    let isCurrent = true;
    setIsSearchingPublic(true);
    const timeoutId = window.setTimeout(() => {
      searchPublicBoards(query)
        .then((results) => {
          if (isCurrent) {
            setPublicResults(results);
          }
        })
        .catch(() => {
          if (isCurrent) {
            setPublicResults([]);
          }
        })
        .finally(() => {
          if (isCurrent) {
            setIsSearchingPublic(false);
          }
        });
    }, 250);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [publicSearch]);

  useEffect(() => {
    for (const sound of sortedSounds) {
      const existingAudio = audioRefs.current.get(sound.id);
      const resolvedUrl = new URL(sound.file_url, window.location.href).href;
      if (!existingAudio || existingAudio.src !== resolvedUrl) {
        const audio = new Audio(sound.file_url);
        audio.preload = "auto";
        audioRefs.current.set(sound.id, audio);
      }
    }

    const activeIds = new Set(sortedSounds.map((sound) => sound.id));
    for (const [soundId] of audioRefs.current) {
      if (!activeIds.has(soundId)) {
        audioRefs.current.delete(soundId);
      }
    }
  }, [sortedSounds]);

  const stopSound = useCallback((soundId: string) => {
    const audio = audioRefs.current.get(soundId);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    if (playingIdRef.current === soundId) {
      playingIdRef.current = null;
      setPlayingId(null);
    }
  }, []);

  const playSound = useCallback((sound: Sound) => {
    if (playingIdRef.current === sound.id) {
      stopSound(sound.id);
      return;
    }

    if (playingIdRef.current) {
      stopSound(playingIdRef.current);
    }

    const audio = audioRefs.current.get(sound.id) ?? new Audio(sound.file_url);
    audioRefs.current.set(sound.id, audio);
    audio.currentTime = 0;
    audio.onended = () => {
      if (playingIdRef.current === sound.id) {
        playingIdRef.current = null;
        setPlayingId(null);
      }
    };
    audio.play().catch(() => setStatus("Browser blocked playback. Click the button once and try again."));
    playingIdRef.current = sound.id;
    setPlayingId(sound.id);
  }, [stopSound]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isAddPanelOpen && event.key === "Escape") {
        setIsAddPanelOpen(false);
        return;
      }
      if (editingSound && event.key === "Escape") {
        setEditingSound(null);
        return;
      }
      if (isAddPanelOpen || editingSound) {
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      const key = event.key.toUpperCase();
      const sound = sortedSounds.find((item) => item.hotkey?.toUpperCase() === key);
      if (sound) {
        event.preventDefault();
        playSound(sound);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingSound, isAddPanelOpen, playSound, sortedSounds]);

  const createAndSelectBoard = async (title: string) => {
    setStatus("");
    const nextBoard = await createBoard(title.trim() || "New Soundboard", boardImageDraft.trim() || undefined);
    setBoard(nextBoard);
    setTitleDraft(nextBoard.title);
    setBoardImageDraft(nextBoard.image_url ?? "");
    localStorage.setItem(LOCAL_BOARD_KEY, nextBoard.id);
    window.history.replaceState(null, "", `?board=${nextBoard.id}`);
    await refreshBoards();
  };

  const handleCreateBoard = () => createAndSelectBoard("New Soundboard");

  const handleDeleteBoard = async (boardId: string) => {
    if (confirmDeleteBoardId !== boardId) {
      setConfirmDeleteBoardId(boardId);
      setStatus("Click delete again to remove the board");
      return;
    }

    await deleteBoard(boardId);
    setConfirmDeleteBoardId(null);
    const nextBoards = await refreshBoards();
    const nextBoardId = nextBoards.find((item) => item.id !== boardId)?.id;
    if (board?.id === boardId) {
      if (nextBoardId) {
        await loadBoard(nextBoardId);
      } else {
        setBoard(null);
        setTitleDraft("My Soundboard");
        setBoardImageDraft("");
        localStorage.removeItem(LOCAL_BOARD_KEY);
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    setStatus("Board deleted");
  };

  const handleAuth = (nextUser: User) => {
    setUser(nextUser);
    setPublicBoard(null);
    setStatus("");
  };

  const handleLogout = async () => {
    await logout().catch(() => undefined);
    setUser(null);
    setBoard(null);
    setBoards([]);
    localStorage.removeItem(LOCAL_BOARD_KEY);
    window.history.replaceState(null, "", window.location.pathname);
  };

  const handleSavePublicBoard = async (publicBoardId: string) => {
    const savedBoard = await savePublicBoard(publicBoardId);
    setPublicBoard(null);
    setBoard(savedBoard);
    setTitleDraft(savedBoard.title);
    setBoardImageDraft(savedBoard.image_url ?? "");
    localStorage.setItem(LOCAL_BOARD_KEY, savedBoard.id);
    window.history.replaceState(null, "", `?board=${savedBoard.id}`);
    await refreshBoards();
    setStatus("Board added to your list");
  };

  const openPublicBoard = (nextBoard: Soundboard) => {
    setPublicBoard(nextBoard);
    setBoard(null);
    window.history.replaceState(null, "", `?board=${nextBoard.id}`);
  };

  const handleSaveTitle = async () => {
    if (!board) {
      await createAndSelectBoard(titleDraft);
      return;
    }
    const nextBoard = await updateBoard(board.id, {
      title: titleDraft.trim() || "Untitled board",
      image_url: boardImageDraft.trim() || null,
    });
    setBoard(nextBoard);
    setBoardImageDraft(nextBoard.image_url ?? "");
    await refreshBoards();
    setStatus("Saved");
  };

  const handleToggleVisibility = async () => {
    if (!board) {
      return;
    }
    const nextBoard = await updateBoard(board.id, { is_public: !board.is_public });
    setBoard(nextBoard);
    await refreshBoards();
    setStatus(nextBoard.is_public ? "Board is public" : "Board is private");
  };

  const handlePrepareYoutube = async () => {
    const cleanedUrl = youtubeUrl.trim();
    if (!cleanedUrl) {
      setStatus("Paste a YouTube URL first.");
      return;
    }

    setStatus("");
    setIsPreparingYoutube(true);
    setYoutubeSource(null);
    try {
      const source = await prepareYoutubeSound(cleanedUrl);
      setYoutubeSource(source);
      setSoundTitle((current) => current || source.title);
      setClipStart(0);
      setClipDuration(Math.min(8, Math.max(1, source.duration)));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not prepare YouTube audio");
    } finally {
      setIsPreparingYoutube(false);
    }
  };

  const handlePreviewYoutubeClip = () => {
    if (!youtubeSource) {
      return;
    }
    if (youtubePreviewTimerRef.current) {
      window.clearTimeout(youtubePreviewTimerRef.current);
      youtubePreviewTimerRef.current = null;
    }

    const audio = youtubePreviewRef.current ?? new Audio(youtubeSource.audio_url);
    youtubePreviewRef.current = audio;
    if (isPreviewingClip) {
      audio.pause();
      setIsPreviewingClip(false);
      return;
    }

    audio.src = youtubeSource.audio_url;
    audio.currentTime = clipStart;
    audio.play().catch(() => setStatus("Browser blocked playback. Click preview once and try again."));
    setIsPreviewingClip(true);
    youtubePreviewTimerRef.current = window.setTimeout(() => {
      audio.pause();
      setIsPreviewingClip(false);
    }, clipDuration * 1000);
  };

  const handleAddSound = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("");
    let activeBoard = board;
    if (!activeBoard) {
      activeBoard = await createBoard(titleDraft.trim() || "My Soundboard", boardImageDraft.trim() || undefined);
      setBoard(activeBoard);
      setBoardImageDraft(activeBoard.image_url ?? "");
      localStorage.setItem(LOCAL_BOARD_KEY, activeBoard.id);
      window.history.replaceState(null, "", `?board=${activeBoard.id}`);
      await refreshBoards();
    }

    const cleanedHotkey = hotkey.trim().slice(0, 1).toUpperCase();
    const cleanedImageUrl = imageUrl.trim();
    if (mode === "upload") {
      if (!file) {
        setStatus("Choose an audio file first.");
        return;
      }
      await uploadSound(activeBoard.id, {
        title: soundTitle.trim() || file.name,
        ...(cleanedImageUrl ? { image_url: cleanedImageUrl } : {}),
        hotkey: cleanedHotkey,
        file,
      });
    } else {
      if (mode === "youtube") {
        if (!youtubeSource) {
          setStatus("Prepare the YouTube audio first.");
          return;
        }
        await clipYoutubeSound(activeBoard.id, {
          source_id: youtubeSource.source_id,
          title: soundTitle.trim() || youtubeSource.title || "YouTube sound",
          start: clipStart,
          duration: clipDuration,
          ...(cleanedImageUrl ? { image_url: cleanedImageUrl } : {}),
          hotkey: cleanedHotkey,
        });
      } else {
      if (!soundUrl.trim()) {
        setStatus("Paste an audio URL first.");
        return;
      }
      await addSoundUrl(activeBoard.id, {
        title: soundTitle.trim() || "Sound",
        file_url: soundUrl.trim(),
        ...(cleanedImageUrl ? { image_url: cleanedImageUrl } : {}),
        hotkey: cleanedHotkey,
      });
      }
    }

    await loadBoard(activeBoard.id);
    await refreshBoards();
    setSoundTitle("");
    setSoundUrl("");
    setYoutubeUrl("");
    setYoutubeSource(null);
    setClipStart(0);
    setClipDuration(8);
    setImageUrl("");
    setHotkey("");
    setFile(null);
    setIsAddPanelOpen(false);
  };

  const handleDelete = async (soundId: string) => {
    if (!board) {
      return;
    }
    if (confirmDeleteId !== soundId) {
      setConfirmDeleteId(soundId);
      return;
    }
    await deleteSound(board.id, soundId);
    setConfirmDeleteId(null);
    await loadBoard(board.id);
    await refreshBoards();
  };

  const openEditSound = (sound: Sound) => {
    setConfirmDeleteId(null);
    setEditingSound(sound);
    setEditTitle(sound.title);
    setEditAudioUrl(sound.file_url);
    setEditImageUrl(sound.image_url ?? "");
    setEditHotkey(sound.hotkey ?? "");
  };

  const handleUpdateSound = async (event: FormEvent) => {
    event.preventDefault();
    if (!board || !editingSound) {
      return;
    }
    await updateSound(board.id, editingSound.id, {
      title: editTitle.trim() || "Sound",
      file_url: editAudioUrl.trim(),
      image_url: editImageUrl.trim() || null,
      hotkey: editHotkey.trim().slice(0, 1).toUpperCase() || null,
    });
    await loadBoard(board.id);
    await refreshBoards();
    setEditingSound(null);
    setStatus("Sound updated");
  };

  const handleCopySound = async (sourceSoundId: string) => {
    if (!board) {
      setStatus("Create or select a board first.");
      return;
    }
    await copySound(board.id, sourceSoundId);
    await loadBoard(board.id);
    await refreshBoards();
    setStatus("Sound added from another board");
  };

  const handleDrop = async (targetId: string) => {
    if (!board || !draggedId || draggedId === targetId) {
      setDraggedId(null);
      return;
    }

    const fromIndex = sortedSounds.findIndex((sound) => sound.id === draggedId);
    const toIndex = sortedSounds.findIndex((sound) => sound.id === targetId);
    const nextSounds = [...sortedSounds];
    const [moved] = nextSounds.splice(fromIndex, 1);
    nextSounds.splice(toIndex, 0, moved);

    setBoard({ ...board, sounds: nextSounds.map((sound, order) => ({ ...sound, order })) });
    setDraggedId(null);
    const nextBoard = await reorderSounds(board.id, nextSounds.map((sound) => sound.id));
    setBoard(nextBoard);
    await refreshBoards();
  };

  const shareUrl = board ? `${window.location.origin}${window.location.pathname}?board=${board.id}` : "";

  if (isCheckingSession) {
    return (
      <main className="app-shell">
        <section className="auth-shell">
          <p className="status">Checking session...</p>
        </section>
      </main>
    );
  }

  if (publicBoard) {
    return <PublicBoard board={publicBoard} onAuth={handleAuth} onSave={user ? handleSavePublicBoard : undefined} />;
  }

  if (!user) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="board-heading">
          <div className="site-row">
            <p className="eyebrow">Soundpad</p>
            <div className="toolbar topbar-actions">
              <span className="user-chip" title={user.email}>
                <UserRound size={18} />
                {user.email}
              </span>
              <button className="icon-button" onClick={board ? handleSaveTitle : handleCreateBoard} title="Save board">
                <Save size={18} />
              </button>
              <button
                className={`icon-button ${isEditMode ? "active" : ""}`}
                onClick={() => {
                  setIsEditMode((current) => !current);
                  setConfirmDeleteId(null);
                  setConfirmDeleteBoardId(null);
                }}
                title={isEditMode ? "Exit edit mode" : "Edit board"}
              >
                <Pencil size={18} />
              </button>
              <button
                className={`visibility-button ${board?.is_public ? "public" : "private"}`}
                disabled={!board}
                onClick={handleToggleVisibility}
                title={board?.is_public ? "Make private" : "Make public"}
              >
                {board?.is_public ? <Globe2 size={18} /> : <Lock size={18} />}
                {board?.is_public ? "Public" : "Private"}
              </button>
              <button
                className="share-button"
                disabled={!board || !board.is_public}
                onClick={() => {
                  navigator.clipboard.writeText(shareUrl);
                  setStatus("Share link copied");
                }}
                title={board?.is_public ? "Copy public link" : "Make board public to share"}
              >
                <Link size={18} />
                Share
              </button>
              <button className="icon-button" onClick={handleLogout} title="Log out">
                <LogOut size={18} />
              </button>
            </div>
          </div>
          <div className="board-title-row">
            {board?.image_url ? (
              <div
                className="board-cover-preview"
                style={{ backgroundImage: `url("${board.image_url}")` }}
                aria-hidden="true"
              />
            ) : null}
            <h1 className="title-display">{titleDraft}</h1>
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="boards-panel">
          <div className="panel-header">
            <span>
              <Layers size={16} />
              Boards
            </span>
            <button className="mini-button" onClick={handleCreateBoard} title="Create board">
              <Plus size={16} />
            </button>
          </div>
          <div className="boards-list">
            {boards.length === 0 ? (
              <p className="muted">No boards yet</p>
            ) : (
              boards.map((item) => (
                <button
                  className={`board-row ${board?.id === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => {
                    setStatus("");
                    setConfirmDeleteBoardId(null);
                    loadBoard(item.id);
                  }}
                >
                  <span className="board-row-title">
                    <span className="board-row-name">
                      <span
                        className={`board-thumb ${item.image_url ? "" : "default-image"}`}
                        style={item.image_url ? { backgroundImage: `url("${item.image_url}")` } : undefined}
                        aria-hidden="true"
                      >
                        {item.image_url ? null : item.title.slice(0, 1).toUpperCase()}
                      </span>
                      <span>{item.title}</span>
                    </span>
                    {isEditMode ? (
                      <button
                        className={`board-delete-button ${confirmDeleteBoardId === item.id ? "confirming" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteBoard(item.id);
                        }}
                        title={confirmDeleteBoardId === item.id ? "Click again to confirm" : "Delete board"}
                      >
                        {confirmDeleteBoardId === item.id ? "Sure?" : <Trash2 size={15} />}
                      </button>
                    ) : null}
                  </span>
                  <small>{item.sounds.length} sounds - {item.is_public ? "public" : "private"}</small>
                </button>
              ))
            )}
          </div>
          <div className="public-search-panel">
            <label>
              <span>
                <Search size={16} />
                Public search
              </span>
              <input
                value={publicSearch}
                onChange={(event) => setPublicSearch(event.target.value)}
                placeholder="Board name"
              />
            </label>
            <div className="boards-list">
              {publicSearch.trim().length >= 2 && publicResults.length === 0 ? (
                <p className="muted">{isSearchingPublic ? "Searching..." : "No public boards"}</p>
              ) : null}
              {publicResults.map((item) => (
                <button className="board-row public-result" key={item.id} onClick={() => openPublicBoard(item)}>
                  <span className="board-row-name">
                    <span
                      className={`board-thumb ${item.image_url ? "" : "default-image"}`}
                      style={item.image_url ? { backgroundImage: `url("${item.image_url}")` } : undefined}
                      aria-hidden="true"
                    >
                      {item.image_url ? null : item.title.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{item.title}</span>
                  </span>
                  <small>{item.sounds.length} sounds - public</small>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className="board-area">
          {status ? <p className="status board-status">{status}</p> : null}
          {isEditMode ? (
            <section className="board-settings-panel">
              <label>
                Board name
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  placeholder="My Soundboard"
                />
              </label>
              <label>
                Board image URL
                <input
                  value={boardImageDraft}
                  onChange={(event) => setBoardImageDraft(event.target.value)}
                  placeholder="https://example.com/cover.jpg"
                />
              </label>
            </section>
          ) : null}
          <section className="board-grid" aria-label="Sound buttons">
            {sortedSounds.length === 0 ? (
              <div className="empty-state">
                <h2>Create the first sound button</h2>
                <p>Use the add tile to create a sound or copy one from another board.</p>
              </div>
            ) : null}
            {sortedSounds.map((sound) => (
                <article
                  className={`sound-tile ${isEditMode ? "editing" : ""} ${playingId === sound.id ? "playing" : ""}`}
                  key={sound.id}
                  draggable
                  onDragStart={() => setDraggedId(sound.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleDrop(sound.id)}
                >
                  <button className="sound-button" onClick={() => playSound(sound)}>
                    <span
                      className={`sound-image ${sound.image_url ? "" : "default-image"}`}
                      style={sound.image_url ? { backgroundImage: `url("${sound.image_url}")` } : undefined}
                      aria-hidden="true"
                    >
                      {sound.image_url ? null : sound.title.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="sound-title">
                      {playingId === sound.id ? <Pause size={18} /> : <Play size={18} />}
                      {sound.title}
                    </span>
                    <span className="sound-meta">{sound.hotkey ? <kbd>{sound.hotkey}</kbd> : null}</span>
                  </button>
                  {isEditMode ? (
                    <div className="edit-actions">
                      <button className="edit-sound-button" onClick={() => openEditSound(sound)} title="Edit sound">
                        <Pencil size={16} />
                      </button>
                      <button
                        className={`delete-button ${confirmDeleteId === sound.id ? "confirming" : ""}`}
                        onClick={() => handleDelete(sound.id)}
                        title={confirmDeleteId === sound.id ? "Click again to confirm" : "Delete sound"}
                      >
                        {confirmDeleteId === sound.id ? "Sure?" : <Trash2 size={16} />}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            <article className="sound-tile add-sound-tile">
              <button className="sound-button add-sound-tile-button" onClick={() => setIsAddPanelOpen(true)}>
                <span className="sound-image default-image">
                  <Plus size={34} />
                </span>
                <span className="sound-title">Add sound</span>
                <span className="sound-meta">Upload, URL, or another board</span>
              </button>
            </article>
          </section>
        </section>
      </section>

      {isAddPanelOpen ? (
        <div className="modal-backdrop" onMouseDown={() => setIsAddPanelOpen(false)}>
          <section className="add-modal" role="dialog" aria-modal="true" aria-label="Add sound" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Add sound</h2>
              <button className="mini-button" onClick={() => setIsAddPanelOpen(false)} title="Close">
                <X size={18} />
              </button>
            </div>

            <div className="segmented">
              <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")} type="button">
                <Upload size={16} />
                Upload
              </button>
              <button className={mode === "url" ? "active" : ""} onClick={() => setMode("url")} type="button">
                URL
              </button>
              <button className={mode === "youtube" ? "active" : ""} onClick={() => setMode("youtube")} type="button">
                <Youtube size={16} />
                YouTube
              </button>
            </div>

            <form onSubmit={handleAddSound} className="sound-form">
              <label>
                Button name
                <input value={soundTitle} onChange={(event) => setSoundTitle(event.target.value)} placeholder="Airhorn" />
              </label>
              <label>
                Hotkey
                <input
                  value={hotkey}
                  onChange={(event) => setHotkey(event.target.value.slice(0, 1).toUpperCase())}
                  placeholder="Q"
                  maxLength={1}
                />
              </label>
              <label>
                Button image URL
                <input
                  value={imageUrl}
                  onChange={(event) => setImageUrl(event.target.value)}
                  placeholder="https://example.com/image.jpg"
                />
              </label>
              {mode === "upload" ? (
                <label>
                  Audio file
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                </label>
              ) : mode === "url" ? (
                <label>
                  Audio URL
                  <input
                    value={soundUrl}
                    onChange={(event) => setSoundUrl(event.target.value)}
                    placeholder="https://example.com/sound.mp3"
                  />
                </label>
              ) : (
                <div className="youtube-clip-panel">
                  <label>
                    YouTube URL
                    <input
                      value={youtubeUrl}
                      onChange={(event) => {
                        setYoutubeUrl(event.target.value);
                        setYoutubeSource(null);
                      }}
                      placeholder="https://www.youtube.com/watch?v=..."
                    />
                  </label>
                  <button
                    className="secondary-button"
                    disabled={isPreparingYoutube}
                    onClick={handlePrepareYoutube}
                    type="button"
                  >
                    <Youtube size={18} />
                    {isPreparingYoutube ? "Preparing..." : "Prepare audio"}
                  </button>
                  {youtubeSource ? (
                    <div className="clip-controls">
                      <div className="clip-meta">
                        <strong>{youtubeSource.title}</strong>
                        <small>{formatSeconds(youtubeSource.duration)}</small>
                      </div>
                      <label>
                        Start: {formatSeconds(clipStart)}
                        <input
                          max={Math.max(0, youtubeSource.duration - 1)}
                          min={0}
                          onChange={(event) => {
                            const nextStart = Number(event.target.value);
                            setClipStart(nextStart);
                            setClipDuration((current) => Math.min(current, Math.max(1, youtubeSource.duration - nextStart)));
                          }}
                          step={0.1}
                          type="range"
                          value={clipStart}
                        />
                      </label>
                      <label>
                        Duration: {formatSeconds(clipDuration)}
                        <input
                          max={Math.min(60, Math.max(1, youtubeSource.duration - clipStart))}
                          min={1}
                          onChange={(event) => setClipDuration(Number(event.target.value))}
                          step={0.1}
                          type="range"
                          value={clipDuration}
                        />
                      </label>
                      <div className="clip-row">
                        <input
                          aria-label="Clip start seconds"
                          min={0}
                          max={Math.max(0, youtubeSource.duration - 1)}
                          onChange={(event) => setClipStart(Number(event.target.value))}
                          step={0.1}
                          type="number"
                          value={clipStart}
                        />
                        <input
                          aria-label="Clip duration seconds"
                          min={1}
                          max={60}
                          onChange={(event) => setClipDuration(Number(event.target.value))}
                          step={0.1}
                          type="number"
                          value={clipDuration}
                        />
                        <button className="secondary-button icon-text-button" onClick={handlePreviewYoutubeClip} type="button">
                          {isPreviewingClip ? <Pause size={18} /> : <Play size={18} />}
                          Preview
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
              <button className="primary-button" type="submit">
                {mode === "youtube" ? <Scissors size={18} /> : <Plus size={18} />}
                {mode === "youtube" ? "Create clip" : "Add button"}
              </button>
            </form>

            <div className="library-panel">
              <div className="panel-header compact">
                <span>
                  <Layers size={16} />
                  Add from boards
                </span>
              </div>
              <div className="library-list">
                {librarySounds.length === 0 ? (
                  <p className="muted">No sounds in other boards</p>
                ) : (
                  librarySounds.map((sound) => (
                    <button className="library-row" key={sound.id} onClick={() => handleCopySound(sound.id)}>
                      <span
                        className={`library-image ${sound.image_url ? "" : "default-image"}`}
                        style={sound.image_url ? { backgroundImage: `url("${sound.image_url}")` } : undefined}
                        aria-hidden="true"
                      >
                        {sound.image_url ? null : sound.title.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="library-copy">
                        <strong>{sound.title}</strong>
                        <small>{sound.boardTitle}</small>
                      </span>
                      <Plus size={16} />
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {editingSound ? (
        <div className="modal-backdrop" onMouseDown={() => setEditingSound(null)}>
          <section
            className="add-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit sound"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Edit sound</h2>
              <button className="mini-button" onClick={() => setEditingSound(null)} title="Close">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleUpdateSound} className="sound-form">
              <label>
                Button name
                <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
              </label>
              <label>
                Hotkey
                <input
                  value={editHotkey}
                  onChange={(event) => setEditHotkey(event.target.value.slice(0, 1).toUpperCase())}
                  maxLength={1}
                />
              </label>
              <label>
                Button image URL
                <input
                  value={editImageUrl}
                  onChange={(event) => setEditImageUrl(event.target.value)}
                  placeholder="https://example.com/image.jpg"
                />
              </label>
              <label>
                Audio URL
                <input
                  value={editAudioUrl}
                  onChange={(event) => setEditAudioUrl(event.target.value)}
                  placeholder="https://example.com/sound.mp3"
                />
              </label>
              <button className="primary-button" type="submit">
                <Save size={18} />
                Save sound
              </button>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function formatSeconds(value: number) {
  const safeValue = Math.max(0, value);
  const minutes = Math.floor(safeValue / 60);
  const seconds = Math.floor(safeValue % 60);
  const tenths = Math.floor((safeValue % 1) * 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

function PublicBoard({
  board,
  onAuth,
  onSave,
}: {
  board: Soundboard;
  onAuth: (user: User) => void;
  onSave?: (boardId: string) => Promise<void>;
}) {
  const [showAuth, setShowAuth] = useState(false);
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sortedSounds = useMemo(() => [...board.sounds].sort((a, b) => a.order - b.order), [board.sounds]);

  const playSound = (sound: Sound) => {
    if (playingId === sound.id && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlayingId(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(sound.file_url);
    audio.onended = () => setPlayingId(null);
    audio.play();
    audioRef.current = audio;
    setPlayingId(sound.id);
  };

  const handleSave = async () => {
    if (!onSave) {
      setShowAuth(true);
      return;
    }
    setStatus("");
    setIsSaving(true);
    try {
      await onSave(board.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add board");
      setIsSaving(false);
    }
  };

  if (showAuth) {
    return <AuthScreen onAuth={onAuth} />;
  }

  return (
    <main className="app-shell">
      <section className="topbar public-topbar">
        <div className="public-heading">
          {board.image_url ? (
            <div
              className="board-cover-preview public-cover"
              style={{ backgroundImage: `url("${board.image_url}")` }}
              aria-hidden="true"
            />
          ) : null}
          <div className="public-heading-copy">
            <p className="eyebrow">Soundpad</p>
            <h1 className="public-title">{board.title}</h1>
          </div>
        </div>
        <div className="toolbar">
          <button className="primary-button" disabled={isSaving} onClick={handleSave}>
            <Plus size={18} />
            Add to my boards
          </button>
          <button className="share-button" onClick={() => setShowAuth(true)}>
            <UserRound size={18} />
            {onSave ? "Switch account" : "Log in"}
          </button>
        </div>
      </section>
      {status ? <p className="status public-status">{status}</p> : null}
      <section className="board-grid public-board-grid" aria-label="Sound buttons">
        {sortedSounds.map((sound) => (
          <article className={`sound-tile ${playingId === sound.id ? "playing" : ""}`} key={sound.id}>
            <button className="sound-button" onClick={() => playSound(sound)}>
              <span
                className={`sound-image ${sound.image_url ? "" : "default-image"}`}
                style={sound.image_url ? { backgroundImage: `url("${sound.image_url}")` } : undefined}
                aria-hidden="true"
              >
                {sound.image_url ? null : sound.title.slice(0, 1).toUpperCase()}
              </span>
              <span className="sound-title">
                {playingId === sound.id ? <Pause size={18} /> : <Play size={18} />}
                {sound.title}
              </span>
              <span className="sound-meta">{sound.hotkey ? <kbd>{sound.hotkey}</kbd> : null}</span>
            </button>
          </article>
        ))}
      </section>
    </main>
  );
}

function AuthScreen({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("");
    setIsSubmitting(true);
    try {
      const auth = mode === "login" ? await login(email, password) : await register(email, password);
      onAuth(auth.user);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="auth-shell">
        <form className="auth-panel" onSubmit={handleSubmit}>
          <p className="eyebrow">Soundpad</p>
          <h1>{mode === "login" ? "Log in" : "Create account"}</h1>
          <div className="segmented">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">
              Log in
            </button>
            <button
              className={mode === "register" ? "active" : ""}
              onClick={() => setMode("register")}
              type="button"
            >
              Register
            </button>
          </div>
          <label>
            Email
            <input
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={8}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {status ? <p className="status">{status}</p> : null}
          <button className="primary-button" disabled={isSubmitting} type="submit">
            <UserRound size={18} />
            {mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
      </section>
    </main>
  );
}
