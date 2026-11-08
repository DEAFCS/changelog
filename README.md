# DEAFCS changelog

DEAFCS patch notes: new features, improvements and fixes, newest first. They also appear on the DEAFCS Changelog page (Info, then Changelog).

## Patch Notes | November 8, 2026

### New

- **Teams:** Teams can pick a country, shown as a flag beside the team name on team pages, match pages and tournament team lists.

### Improved

- **Matches:** Restart Map now warns that recorded rounds will be set aside.
- **Matches:** Only staff can restore rounds or restart a map from the match page.

### Fixed

- **Teams:** Only the team owner can hand over a team, and the owner can no longer be removed or demoted by others.
- **Profiles:** The match filters on player profiles fit on one line on more screen sizes.
- **Teams:** The Save button in the team editor is fully visible again on every screen size.
- **Matches:** Restoring a round no longer counts kills and damage from the interrupted round twice.

## Patch Notes | November 7, 2026

### New

- **Profiles:** Season awards show their season and game mode.
- **Awards:** You get a notification when you receive a season medal.
- **Utility:** Lineups you save on your practice server now appear right away in a This Server group at the top of Mine, numbered in save order.
- **Matches:** A Utility tab shows every grenade on CT and T maps, checked against the common lineups, with Watch and Save.
- **Utility:** Lineups with saved bots show a badge on the map, and each bot's spot when you open the lineup.

### Improved

- **Leaderboards:** The Awards board now ranks players by Gold, then Silver, Bronze, MVP and Special.
- **Leaderboards:** Stat tables can now be sorted with the keyboard and announce their sort order to screen readers.
- **Streams:** Live streams stay closer to real time when they fall behind.

### Fixed

- **Leaderboards:** A player's Awards rank now matches their place on the board.
- **Utility:** Refreshing the page no longer loses your place in a friend's practice server.
- **Streams:** Audio stays in sync with the picture on long live streams.
- **Highlights:** A clip's thumbnail is now saved before the clip is finished, so fewer clips appear without one.

## Patch Notes | November 6, 2026

### New

- **Matchmaking:** DEAFCS Pro is a scheduled solo 5v5 queue with Captain Pick for top-ranked players.

### Improved

- **Tournaments:** Cancelling a tournament or resetting it to Setup now asks for confirmation first.
- **Matchmaking:** Each mode shows its map pool when you hover or tap its info icon.
- **Matchmaking:** The Play page shows Competitive, Wingman and Duel in a cleaner layout on every screen size.
- **Matches:** Maps a Grand Final did not need are muted and marked Not needed.
- **Tournaments:** Administrators can delete a tournament with rated matches without voiding ELO first.
- **Tournaments:** Organizers can reset or change a match winner without voiding ELO first.

### Fixed

- **Matches:** Organizers can cancel a match that already has a demo.
- **Matches:** Canceled matches no longer count toward player statistics or leaderboards.
- **Matches:** A canceled match keeps its played maps, rounds and stats, even before its demo arrives.
- **Tournaments:** Changing an earlier result no longer swaps the teams of a canceled match that was already played.
- **Tournaments:** A tournament can no longer be cancelled or deleted while its matches are being played.
- **Matches:** A match started again right after a cancel keeps its server.
- **Matches:** A canceled match that is started again replays the unfinished map from warmup and keeps its finished maps.
- **Tournaments:** A tournament with played matches can no longer be reset to Setup.
- **Tournaments:** Organizers can recover an unfinished series without awarding a win, and resetting a match keeps its finished maps.
- **Tournaments:** Correcting the winner of a final now finishes the tournament again.
- **Tournaments:** The Grand Final uses its own best-of and map advantage at any bracket size.
- **Matches:** The match page shows the upper bracket team's Grand Final map advantage.
- **Tournaments:** The bracket and match lists show a Grand Final's full series score, including the upper bracket advantage.
- **Matches:** Setting a map winner in a Grand Final counts the upper bracket team's map advantage.

## Patch Notes | November 5, 2026

### New

- **ELO:** Competitive ELO now depends mostly on the result and the strength of both teams.
- **ELO:** Your match rating counts for up to 10% of your Competitive ELO change.

### Improved

- **ELO:** Competitive gains and losses get smaller above 10,000 ELO, about ±50 at 20,000.
- **ELO:** Competitive ELO can't drop below 1,000.
- **Matchmaking:** Leaving a Competitive, Wingman or Duel match now gives 50% of the gain if your team wins, or twice the loss if your team loses.
- **Matchmaking:** In Duel and Wingman, wins against the same opponent are worth less after three meetings in 7 days. Losses aren't affected.
- **ELO:** The ELO popup explains leaver and repeat opponent adjustments.
- **ELO:** Your current ELO and past matches stay as they are. The new rules apply to matches that start from now on.

## Patch Notes | November 4, 2026

### New

- **Tournaments:** Organizers can turn on AIM Rules for a Duel tournament: 3 second freeze time, free Kevlar, no buy time and a 3 second delay between rounds.

### Improved

- **Navigation:** The left sidebar has clearer groups, with Community, Updates and Info sections.
- **Navigation:** The Info section stays open or closed after a page reload, like the other sections.
- **Rules:** General, Matchmaking and Tournament Rules are now one Rules page with three tabs.
- **Navigation:** The Info section is shorter, and the collapsed sidebar shows it as one icon with a menu.

## Patch Notes | November 3, 2026

### New

- **Matches:** Report a player from their row on the scoreboard or the "..." menu next to their name, in a popup with a reason, the map and the round.
- **Matches:** The scoreboard shows each player's CS2 teammate color.
- **Tournaments:** Organizers can turn ELO off for a tournament in its settings, before the first match starts.
- **Practice:** Verified players can open Public Servers in the Practice section, and each server card can show its own picture.
- **Highlights:** Share on a clip opens Copy link and Download, and a clip's owner and staff can delete it right from the tile.

### Improved

- **Support:** The Contact page shows with pictures how to call support in a match and how to report a player.
- **Support:** Call for Support now explains where to report a player instead.
- **Changelog:** Each day's patch notes are grouped by section, with a New, Improved or Fixed tag on every change.
- **Matches:** Match page highlight clips load with less work for the site.
- **Servers:** The Public Servers page and the Play page's server card load with less work for the site.
- **Leaderboards:** Leaderboards show fades and buttons on edges with more columns to scroll to.
- **Profiles:** Player profiles load with less work for the site and show changes made elsewhere on your next visit.

### Fixed

- **Matchmaking:** Regions with only public servers (Deathmatch, Retake) no longer show up in matchmaking, so you can't queue where no match server can start.
- **Matches:** Match logs, system logs and RCON command suggestions show player names and plugin text as plain text.
- **Tournaments:** Removing a category from a tournament works again.
- **Tournaments:** Free-agent-only tournaments offer "Join as a free agent" instead of "Register" on their cards.
- **Highlights:** A deleted clip leaves every list and playlist without a reload.
- **Highlights:** Deleting the first clip of a match group shows the next clip right away instead of the deleted one.
- **Highlights:** Only a clip's creator and staff can change or delete it, and only its creator can rename it.

## Patch Notes | November 2, 2026

### Improved

- **Matches:** Match pages open faster, and the scoreboard keeps players in a steady ADR order during live matches.

### Fixed

- **Support:** Older player reports show the reported player's profile link again.
- **Profiles:** Team kills, suicides and assists on teammates no longer count toward your kills, assists and weapon stats.
- **Leaderboards:** Kill and K/D boards no longer count team kills or suicides as kills.
- **Tournaments:** Stats tabs and the standings tiebreaker count kills and deaths the same way as everywhere else.

## Patch Notes | November 1, 2026

Team history on profiles and team pages, a new Changelog page, a new search, and matchmaking by region.

### New

- **Teams:** Player profiles now show current and previous teams, with available membership history.
- **Teams:** Team pages show a roster history of current and former members.
- **Teams:** The team activity feed shows when players join, rejoin, leave or are removed.
- **Changelog:** A new Changelog page under Info shows patch notes by day, with search, filters and a dot for new changes.
- **Matchmaking:** EU and SA are now separate region groups, and the Play page counts the queue for your region group.
- **Search:** Press Ctrl+K (Cmd+K on Mac) or use Search in the left menu to find pages, players, FAQ answers and your settings.

### Improved

- **Matchmaking:** Each region group can open or close matchmaking modes on its own, and the Play page shows what is open in your region.
- **Matchmaking:** If a mode closes while you are in its queue, you leave the queue and get a message.
- **Profiles:** Choose EU or SA from a dropdown in settings or on your profile. Staff approve the change.
- **Notifications:** Your notifications, friends and My Matches appear sooner when a page opens.
- **Performance:** The Teams page, league seasons, tournament bracket previews and the utility library stay quick when many people view them at once.
- **Matches:** The scoreboard keeps players in ADR order in every view, rows move smoothly when their positions change, and stat numbers roll like an odometer.
- **Teams:** The team page tabs are one full-width bar under the team header, with the active tab highlighted, and it stays on screen while you scroll.
- **Leaderboards:** K/D, HS% and rating boards filtered by source or role load much faster.
- **Matches:** Report details no longer show an empty profile row.

### Fixed

- **Matches:** Stream and demo startup progress now shows the workshop map download in the right order.
- **Matchmaking:** When a mode is closed, a ready check that fails no longer puts you back in its queue or starts a new one.
- **Highlights:** A clip you make private leaves the public Highlights and Watch lists right away.
- **Teams:** Team cards show a space before "vs" in the Next and Last rows.
- **Accounts:** After your role changes, the site picks up your new permissions right away without a reload.
- **Matches:** A late duplicate status from a game server no longer ends the next map early or loses a map's result.
- **Steam:** Steam messages that Steam delays or rate-limits are retried instead of lost, and are never sent twice.
- **Seasons:** Rebuilding a season's ratings now keeps its tournament matches, so season ELO stays correct.
- **Matches:** Report a Player opens 5 minutes after the match ends, and the match page shows the time left.
- **Matches:** Player names show correctly when choosing who to report.

Older days are in [entries](entries).
