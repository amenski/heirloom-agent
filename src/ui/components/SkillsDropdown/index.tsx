import React, { useEffect, useState } from "react";
import { useInput } from "ink";
import DropdownMenu from "../DropdownMenu/index.js";
import { useTheme } from "../../contexts.js";
import { ansi256 } from "../../theme.js";

export interface SkillInfo {
  name: string;
  description?: string;
  path?: string;
  isLoaded?: boolean;
}

interface Props {
  open: boolean;
  width: number;
  skills: SkillInfo[];
  selectedSkills: SkillInfo[];
  onSelect: (skill: SkillInfo) => void;
  onClose: (open: boolean) => void;
}

const SkillsDropdown: React.FC<Props> = ({ open, width, skills, selectedSkills, onSelect, onClose }) => {
  const theme = useTheme();
  const accent = theme.colorEnabled ? ansi256(theme.theme.accent) : undefined;
  const [index, setIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow) { setIndex((i) => (i - 1 + skills.length) % skills.length); return; }
      if (key.downArrow) { setIndex((i) => (i + 1) % skills.length); return; }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) {
        const skill = skills[index];
        if (skill) onSelect(skill);
        return;
      }
      if (key.tab) { onClose(false); return; }
      if (key.escape) { onClose(false); return; }
    },
    { isActive: open },
  );

  useEffect(() => { if (index >= skills.length) setIndex(Math.max(0, skills.length - 1)); }, [skills.length, index]);

  if (!open) return null;

  return (
    <DropdownMenu
      width={width}
      title="Select Skills"
      helpText="Space toggle · Enter toggle · Esc to close"
      emptyText="No skills found"
      items={skills.map((skill) => ({
        key: skill.name,
        label: skill.name,
        description: skill.path,
        selected: selectedSkills.some((s) => s.name === skill.name),
        statusIndicator: skill.isLoaded ? { symbol: "✓", color: "green" } : undefined,
      }))}
      activeIndex={index}
      activeColor={accent}
      maxVisible={6}
    />
  );
};

export default SkillsDropdown;
