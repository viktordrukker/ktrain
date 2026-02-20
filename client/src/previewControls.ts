type PreviewAppSettings = {
  soundEnabled: boolean;
  mistakeStyle: "gentle" | "normal";
  correctEffects: {
    randomizeSound: boolean;
    sound: "chime" | "pop" | "bell" | "sparkle" | "off";
  };
};

export type PreviewControlState = {
  canPlaySound: boolean;
  playSoundHint: string;
  mistakeHint: string;
};

export function getPreviewControlState(settings: PreviewAppSettings): PreviewControlState {
  const canPlaySound = Boolean(settings.soundEnabled && (settings.correctEffects.randomizeSound || settings.correctEffects.sound !== "off"));
  const playSoundHint = canPlaySound
    ? "Plays a sample using the current sound effect settings."
    : "Enable Sound and choose a sound effect to preview audio.";
  const mistakeHint = settings.mistakeStyle === "gentle"
    ? "Shows mistake highlight only (sound stays calm in gentle mode)."
    : "Shows mistake highlight and mistake sound.";
  return {
    canPlaySound,
    playSoundHint,
    mistakeHint
  };
}
