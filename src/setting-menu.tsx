import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SettingMenuOption = { id: string; label: string; description?: string };

export function SettingMenu({ className, label, value, options, placeholder, title, disabled, onChange, direction = "up" }: {
  className: string;
  label: string;
  value: string;
  options: SettingMenuOption[];
  placeholder: string;
  title: string;
  disabled: boolean;
  onChange: (value: string) => void;
  direction?: "up" | "down";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.id === value);
  const menuId = useId();

  useEffect(() => {
    if (disabled || options.length === 0) setOpen(false);
  }, [disabled, options.length]);
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  function choose(option: SettingMenuOption) {
    if (option.id !== value) onChange(option.id);
    setOpen(false);
  }

  function moveActive(step: number) {
    setActiveIndex((current) => (current + step + options.length) % options.length);
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
      else setOpen(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return <div ref={rootRef} className={`setting-menu ${className}`}>
    <button type="button" className="setting-select" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} disabled={disabled} title={title} onClick={() => setOpen((current) => !current)} onKeyDown={keyDown}>
      <span>{label}</span><strong className="setting-value">{(selected?.label ?? value) || placeholder}</strong><ChevronDown size={13} />
    </button>
    {open && <div id={menuId} className={`setting-menu-panel ${direction === "down" ? "open-down" : ""}`} role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={`${option.id === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.id === value && <Check size={14} />}
      </button>)}
    </div>}
  </div>;
}
