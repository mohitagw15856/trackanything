# Records assets/demo.gif. Install https://github.com/charmbracelet/vhs, then:
#   vhs demo.tape
#
# Uses `trackanything demo`, which runs on invented data and fetches nothing --
# so the recording never shows a real watchlist and is identical on any machine.

Output assets/demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1000
Set Height 620
Set Padding 24
Set Theme "Builtin Dark"
Set TypingSpeed 45ms

Hide
Type "clear" Enter
Show

Sleep 700ms
Type "trackanything demo"
Sleep 400ms
Enter
Sleep 5s

Type "trackanything add https://shop.example/thing"
Sleep 400ms
Enter
Sleep 3s
