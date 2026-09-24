// voice/voices.js
// The 30 prebuilt voices Gemini Live supports in speechConfig.voiceConfig.
// prebuiltVoiceConfig.voiceName — see voice/live.js for where this is
// actually sent. Source: Gemini Live API docs ("Voices supported").

export const DEFAULT_VOICE = "Kore";

export const GEMINI_VOICES = [
    { name: "Zephyr", tag: "Bright" },
    { name: "Puck", tag: "Upbeat" },
    { name: "Charon", tag: "Informative" },
    { name: "Kore", tag: "Firm" },
    { name: "Fenrir", tag: "Excitable" },
    { name: "Leda", tag: "Youthful" },
    { name: "Orus", tag: "Firm" },
    { name: "Aoede", tag: "Breezy" },
    { name: "Callirrhoe", tag: "Easy-going" },
    { name: "Autonoe", tag: "Bright" },
    { name: "Enceladus", tag: "Breathy" },
    { name: "Iapetus", tag: "Clear" },
    { name: "Umbriel", tag: "Easy-going" },
    { name: "Algieba", tag: "Smooth" },
    { name: "Despina", tag: "Smooth" },
    { name: "Erinome", tag: "Clear" },
    { name: "Algenib", tag: "Gravelly" },
    { name: "Rasalgethi", tag: "Informative" },
    { name: "Laomedeia", tag: "Upbeat" },
    { name: "Achernar", tag: "Soft" },
    { name: "Alnilam", tag: "Firm" },
    { name: "Schedar", tag: "Even" },
    { name: "Gacrux", tag: "Mature" },
    { name: "Pulcherrima", tag: "Forward" },
    { name: "Achird", tag: "Friendly" },
    { name: "Zubenelgenubi", tag: "Casual" },
    { name: "Vindemiatrix", tag: "Gentle" },
    { name: "Sadachbia", tag: "Lively" },
    { name: "Sadaltager", tag: "Knowledgeable" },
    { name: "Sulafat", tag: "Warm" }
];

export function voiceTag(name) {
    const found = GEMINI_VOICES.find((v) => v.name === name);
    return found ? found.tag : "";
}
