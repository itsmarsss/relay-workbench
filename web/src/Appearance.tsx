import { createContext, useContext } from 'react';
import { Select } from './UI';
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
      <label className="field">
        Theme
        <Select
          label="Theme"
          value={theme}
          onChange={(value) => setTheme(value as Theme)}
          options={['system', 'light', 'dark'].map((value) => ({
            value,
            label: value[0]!.toUpperCase() + value.slice(1),
          }))}
        />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={lowMotion}
          onChange={(event) => setLowMotion(event.target.checked)}
        />
        Low motion
      </label>
      <p className="form-note">Turn off animations and transitions. Saved in this browser.</p>
    </section>
  );
}
