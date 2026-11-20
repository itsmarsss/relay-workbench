import { createContext, useContext } from 'react';
export type Theme = 'system' | 'light' | 'dark';
export const Appearance = createContext({
  theme: 'system' as Theme,
  setTheme: (_value: Theme) => {},
  lowMotion: false,
  setLowMotion: (_value: boolean) => {},
});
export function AppearanceSettings() {
  const { theme, setTheme, lowMotion, setLowMotion } = useContext(Appearance);
  return (
    <section className="surface appearance-settings">
      <h2>Appearance</h2>
      <div className="field">
        <span id="theme-label">Theme</span>
        <div className="segmented theme-switch" role="group" aria-labelledby="theme-label">
          {(['system', 'light', 'dark'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <label className="check-row permission-row">
        <input
          type="checkbox"
          aria-label="Low motion"
          checked={lowMotion}
          onChange={(event) => setLowMotion(event.target.checked)}
        />
        <span>
          Low motion
          <small>Turn off animations and transitions. Saved in this browser.</small>
        </span>
      </label>
    </section>
  );
}
