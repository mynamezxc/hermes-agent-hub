"""Agents Hub agent half: registers the bundled skills (``agents-hub:<name>``).

The Hub's routes live in ``dashboard/plugin_api.py`` and its page in ``desktop/plugin.js``; this
module only makes the operating guides loadable with ``skill_view("agents-hub:hub-operating")``.
"""
from pathlib import Path


def register(ctx):
    skills_dir = Path(__file__).parent / "skills"
    if not skills_dir.is_dir():
        return
    for child in sorted(skills_dir.iterdir()):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.is_file():
            ctx.register_skill(child.name, skill_md)
