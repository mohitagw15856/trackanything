# Records assets/demo.gif. Install https://github.com/charmbracelet/vhs, then:
#   vhs demo.tape
#
# `trackanything demo` runs on invented data and fetches nothing. The `add` runs
# against the fixture server in this repo rather than a real shop, so the
# recording never depends on somebody else's site being up on the day, and never
# shows a real watchlist.

Output assets/demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1220
Set Height 640
Set Padding 22
Set Theme "Builtin Dark"
Set TypingSpeed 40ms

Hide
Type "export TRACKANYTHING_DIR=$(mktemp -d) && node fixtures/serve.mjs >/dev/null 2>&1 & sleep 1 && clear" Enter
Show

Sleep 600ms
Type "trackanything demo"
Sleep 400ms
Enter
Sleep 5s

Type "trackanything add http://127.0.0.1:8787/headphones"
Sleep 400ms
Enter
Sleep 4s

Hide
Type "kill %1 2>/dev/null; rm -f trackanything-demo.html" Enter
Show
