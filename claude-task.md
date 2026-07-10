# Task: Rebuild UI — Modern Light Design

## Context
- Project: /home/hamiddi/projects/jom-content/index.html
- Backup: /home/hamiddi/projects/jom-content/index.html.bak (pre-Claude backup)
- Current version has Claude Code's previous changes (search, export, toast, etc.)
- DO NOT revert those features — BUILD ON TOP of the current index.html

## Design Direction (from user-approved mockup)

**Color Palette:**
- Background: #ffffff (pure white) and #f8fafc (light grey sections)
- Sidebar: #1E3A8A (dark navy) with white icons/text
- Cards: White (#fff) with subtle box-shadow: 0 1px 3px rgba(0,0,0,.08), border-radius: 12px
- Platform colors: TikTok=#fe2c55, Facebook=#1877f2, Instagram=#e4405f, Threads=#101010
- Pillar colors: keep existing dynamic color system
- Primary accent: #1E3A8A (navy)
- Text: #1a1d23 primary, #5f6779 secondary
- Border: #e2e6ef (light grey)

**Layout Change:**
- REPLACE the top nav tabs with a LEFT SIDEBAR (fixed, ~220px wide)
- Sidebar has: App logo "Jom Content" at top, then platform nav items with icons + labels, Dashboard at top
- Active nav item highlighted with white text on navy (or light navy bg)
- Main content area shifts right (margin-left: 220px)
- Header bar at top of content area (not in sidebar) with stats + buttons

**Component Design:**
1. **Header** (top of main content):
   - Left: page title + month indicator
   - Right: export/import/backup buttons + dark mode toggle

2. **Stat Cards** (dashboard):
   - White card with rounded corners, subtle shadow
   - Large number in navy, small label below
   - Platform-specific stat cards have colored accent dots
   - Grid: auto-fit, min 160px

3. **Charts:**
   - Donut chart: clean, with center hole showing total
   - Bar chart: rounded bars, clean labels
   - Both in white cards with subtle headers

4. **Calendar:**
   - Clean grid with rounded day cells
   - Today has navy border highlight
   - Post chips as small colored dots/badges
   - Month navigation with clean buttons

5. **Content Pillars section:**
   - Pillar tags as colored chips
   - Target vs actual bars with percentage labels
   - Clean filter bar below

6. **Post List:**
   - Clean rows with date, title, pillar chip, status badge
   - Hover effect with subtle background change

7. **Modal:**
   - Clean white modal with scale-in animation
   - Form fields with proper spacing
   - Footer with action buttons

8. **Empty states:**
   - Large centered icon, subtle message

## Features That MUST Be Preserved
All features added by Claude Code's previous run:
- ✓ Search bar (🔍 Cari post...)
- ✓ CSV export button
- ✓ JSON backup/import
- ✓ Toast notifications
- ✓ Post count badges on nav
- ✓ Keyboard shortcuts (Escape to close)
- ✓ Duplicate post button
- ✓ Dark mode toggle (still works)
- ✓ All existing data model (LocalStorage keys, state structure)

## Constraints
- SINGLE HTML file only — no external CSS/JS
- Keep LocalStorage data model EXACTLY as-is (state.posts, state.pillars, state.calDates, state.pillarTargets)
- Keep all 4 platforms: tiktok, facebook, instagram, threads
- Keep content pillars: Kulit, Weight Loss, General Care with 50/30/20 targets
- Dark mode toggle must remain functional (using data-theme attribute, existing CSS vars)
- Mobile responsive at 375px — sidebar collapses to top nav or hamburger
- Zero console errors on load
- All onclick handlers, function names must stay compatible

## Instructions
1. Read the full current index.html first
2. Plan the layout restructure (sidebar + main area)
3. Rewrite the CSS with the new design system
4. Rewrite the HTML structure for sidebar layout
5. Keep ALL JavaScript functions intact — only update render functions if needed for new HTML structure
6. Test that no console errors occur
7. Verify dark mode still works

## DO NOT
- Remove or rename any existing JS function
- Change the LocalStorage data structure
- Remove search, export, import, toast, badges, duplicate features
- Add external dependencies or CDN links
- Remove dark mode
- Change the deploy workflow
