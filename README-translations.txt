
mkdir locale
xgettext --output=locale/multi-account-github-notifications.pot *.js
mkdir -p locale/de/LC_MESSAGES
msginit --locale de --input local/multi-account-github-notifications.pot --output local/de/LC_MESSAGES/multi-account-github-notifications.po

cd locale/de/LC_MESSAGES
edit multi-account-github-notifications.po with proper translations
msgfmt multi-account-github-notifications.po --output-file multi-account-github-notifications.mo
