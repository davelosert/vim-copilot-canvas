export const defaultEditorFont = "neon";

export const editorFonts = {
    neon: { label: "Monaspace Neon", family: '"Monaspace Neon", "SFMono-Regular", Consolas, monospace' },
    argon: { label: "Monaspace Argon", family: '"Monaspace Argon", "SFMono-Regular", Consolas, monospace' },
    krypton: { label: "Monaspace Krypton", family: '"Monaspace Krypton", "SFMono-Regular", Consolas, monospace' },
    radon: { label: "Monaspace Radon", family: '"Monaspace Radon", "SFMono-Regular", Consolas, monospace' },
    xenon: { label: "Monaspace Xenon", family: '"Monaspace Xenon", "SFMono-Regular", Consolas, monospace' },
    system: { label: "System monospace", family: '"SFMono-Regular", Consolas, monospace' },
};

export const fontOptions = Object.entries(editorFonts).map(([value, { label }]) => ({ value, label }));
