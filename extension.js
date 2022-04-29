/* This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* Based on https://github.com/alexduf/gnome-github-notifications */

const GETTEXT_DOMAIN = 'multi-account-github-notifications';
const Gettext = imports.gettext.domain(GETTEXT_DOMAIN);
const _ = Gettext.gettext;
const ngettext = Gettext.ngettext;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const {GObject, GLib, Gio, St, Gtk} = imports.gi;
const Lang = imports.lang;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Soup = imports.gi.Soup;

const Settings = ExtensionUtils.getSettings('com.github.mneilly.multi-account-github-notifications');
const DEBUG = true;

// Message wrappers

/**
 * Wrapper for debug messages. Just returns if the DEBUG global is false.
 * @param msg The message to log.
 */
function debug(msg) {
    if (DEBUG) {
        log(`[MAGN][DEBUG] ${msg}`)
    }
}

/**
 * Wrapper for error messages.
 * @param msg The message to log.
 */
function error(msg) {
    log(`[MAGN][ERROR] ${msg}`);
}

/**
 * Wrapper for warning messages.
 * @param msg The message to log.
 */
function warning(msg) {
    log(`[MAGN][WARNING] ${msg}`);
}

/**
 * Wrapper for informational messages.
 * @param msg The message to log.
 */
function info(msg) {
    log(`[MAGN][INFO] ${msg}`);
}

const ICON_COUNT = 0
const ICON_WARNING = 1

const STATUS_NORMAL = 0
const STATUS_WARNING = 1

const Indicator = GObject.registerClass(
    /**
     * The main indicator widget that gets put in the status bar.
     */
    class Indicator extends PanelMenu.Button {

        static lastIconSet = 0; // stores the last loaded icon set number

        _init(id) {
            debug("_init: enter\n");
            super._init(0.0, _(`Github Notification ${id}`));
            this.accountId = id;
            this.notifications = [];
            this.status = STATUS_NORMAL;

            // Get settings needed for init
            let login = Settings.get_strv('login')[this.accountId];
            let filter = Settings.get_string('filter');
            this.iconSet = Settings.get_boolean('icon-set');

            // Setup icons
            this.loadIcons();
            this.lastIconSet = this.iconSet;
            this.icon = new St.Icon({
                gicon: this.msgCntIcons[0],
                style_class: `system-status-icon gh-account${this.accountId}-style`
            });
            this.setIcon();

            // Add icon and label to status bar

            this.box = new St.BoxLayout({
                reactive: true,
                can_focus: true,
                track_hover: true
            });
            this.label = new St.Label({
                text: '' + this.notifications.length,
                style_class: 'system-status-icon'
            });

            this.box.add_actor(this.icon);
            this.box.add_actor(this.label);
            this.add_child(this.box);

            // Create menu to select notifications or settings

            let item = new PopupMenu.PopupMenuItem(_(`${login} Notifications`));
            item.connect('activate', () => {
                this.showBrowserUri();
            });
            this.menu.addMenuItem(item);

            item = new PopupMenu.PopupMenuItem(_('Settings'));
            item.connect('activate', () => {
                if (ExtensionUtils.openPrefs) {
                    ExtensionUtils.openPrefs();
                } else {
                    let cmd = `gnome-shell-extension-prefs ${uuid}`;
                    GLib.spawn_command_line_sync(cmd);
                }
            });
            this.menu.addMenuItem(item);
            debug("_init: done\n");
        };

        /**
         * Loads the current icon set. If the current set is the same as the last set return without doing anything.
         */
        loadIcons() {
            if (this.lastIconSet === this.iconSet) {
                return;
            }

            this.iconWarning = Gio.icon_new_for_string(`${Me.path}/icons/set${this.iconSet}/github-warning.svg`);

            this.msgCntIcons = [
                Gio.icon_new_for_string(`${Me.path}/icons/set${this.iconSet}/github.svg`),
                Gio.icon_new_for_string(`${Me.path}/icons/set${this.iconSet}/github-1.svg`),
                Gio.icon_new_for_string(`${Me.path}/icons/set${this.iconSet}/github-2.svg`),
                Gio.icon_new_for_string(`${Me.path}/icons/set${this.iconSet}/github-3.svg`),
                Gio.icon_new_for_string(`${Me.path}/icons/set${this.iconSet}/github-asterisk.svg`),
            ]

            this.lastIconSet = this.iconSet;
        }

        /**
         * Sets the current icon based on message count and warning status.
         */
        setIcon() {
            debug("setIcon: enter\n");
            if (this.status === STATUS_NORMAL) {
                let idx = Math.min(this.notifications.length, this.msgCntIcons.length - 1);
                if (!this.hideCount) {
                    idx = 0;
                }
                this.icon.gicon = this.msgCntIcons[idx];
            } else if (this.status === STATUS_WARNING) {
                this.icon.gicon = this.iconWarning;
            }
            this.icon.set_style(`border-top: 2px solid ${this.color};`);
            debug("setIcon: done\n");
        }

        /**
         * Called at regular intervals...
         * @returns {number}
         */
        interval() {
            debug("interval: enter\n");
            this.setIcon();
            let i = this.refreshInterval
            if (this.retryAttempts > 0) {
                i = Math.max(this.retryAttempts * this.refreshInterval, 600);
            }
            debug("interval: done\n");
            return Math.max(i, this.githubInterval);
        }

        /**
         *
         */
        lazyInit() {
            debug("lazyInit: enter\n");
            this.hasLazilyInit = true;
            this.reloadSettings();
            this.loadIcons();
            this.status = STATUS_NORMAL;
            this.initHttp();
            Settings.connect('changed', Lang.bind(this, function () {
                this.reloadSettings();
                this.setIcon();
                this.status = STATUS_NORMAL;
                this.initHttp();
                this.stopLoop();
                this.planFetch(5, false);
            }));
            debug("lazyInit: done\n");
        }

        /**
         *
         */
        start() {
            debug("start: enter\n");
            if (!this.hasLazilyInit) {
                this.lazyInit();
            }
            this.fetchNotifications();
            debug("start: done\n");
        }

        /**
         *
         */
        stop() {
            debug("stop: enter\n");
            this.stopLoop();
            debug("stop: done\n");
        }

        /**
         *
         */
        reloadSettings() {
            debug("reloadSettings: enter\n");
            this.domain = Settings.get_strv('domain')[this.accountId];
            this.token = Settings.get_strv('token')[this.accountId];
            this.login = Settings.get_strv('login')[this.accountId];
            this.color = Settings.get_strv('color')[this.accountId];
            this.command = Settings.get_strv('command')[this.accountId];
            this.iconSet = Settings.get_int('icon-set');
            this.hideWidget = Settings.get_boolean('hide-widget');
            this.hideCount = Settings.get_boolean('hide-notification-count');
            this.refreshInterval = Settings.get_int('refresh-interval');
            this.githubInterval = this.refreshInterval;
            this.showAlertNotification = Settings.get_boolean('show-alert');
            this.filter = Settings.get_boolean('filter');
            this.checkVisibility();
            debug("reloadSettings: done\n");
        }

        /**
         * Checks and sets the visibility of the message count.
         */
        checkVisibility() {
            debug("checkVisibility");
            this.visible = !this.hideWidget || this.notifications.length !== 0;
            if (this.label) {
                this.label.visible = !this.hideCount;
            }
            debug(`checkVisibility done`);
        }

        /**
         *
         */
        stopLoop() {
            debug("stopLoop: enter\n");
            if (this.timeout) {
                Mainloop.source_remove(this.timeout);
                this.timeout = null;
            }
            debug("stopLoop: done\n");
        }

        getUrl() {
            let url = `https://api.${this.domain}/notifications`;
            if (this.filter !== "none") {
                url = `${url}?query=reason%3A${this.filter}`;
            }
            return url;
        }

        /**
         * Show notificiations in the users browser based on the selected filter.
         */
        showBrowserUri() {
            debug("showBrowserUri: enter\n");
            let url = this.getUrl();
            try {
                if (this.command) {
                    let cmd = this.command + " " + url;
                    GLib.spawn_command_line_sync(cmd);
                } else {
                    Gtk.show_uri(null, url, Gtk.get_current_event_time());
                }
            } catch (e) {
                error("Cannot open uri " + e)
            }
            debug("showBrowserUri: done\n");
        }

        /**
         *
         */
        initHttp() {
            debug("initHttp: enter\n");
            let url = this.getUrl();

            this.status = STATUS_NORMAL;
            if (!this.login || !this.token) {
                this.status = STATUS_WARNING;
                return;
            }

            this.authUri = new Soup.URI(url);
            this.authUri.set_user(this.login);
            this.authUri.set_password(this.token);

            if (this.httpSession) {
                this.httpSession.abort();
            } else {
                this.httpSession = new Soup.Session();
                this.httpSession.user_agent = 'gnome-shell-extension github notification via libsoup';

                this.authManager = new Soup.AuthManager();
                this.auth = new Soup.AuthBasic({host: 'api.' + this.domain, realm: 'Github Api'});

                this.authManager.use_auth(this.authUri, this.auth);
                Soup.Session.prototype.add_feature.call(this.httpSession, this.authManager);
            }
            debug("initHttp: done\n");
        }

        /**
         *
         * @param delay
         * @param retry
         */
        planFetch(delay, retry) {
            debug("planFetch: enter\n");
            if (retry) {
                this.retryAttempts++;
            } else {
                this.retryAttempts = 0;
            }
            this.stopLoop();
            this.timeout = Mainloop.timeout_add_seconds(delay, Lang.bind(this, function () {
                this.fetchNotifications();
                return false;
            }));
            debug("planFetch: done\n");
        }

        /**
         *
         */
        fetchNotifications() {
            debug("fetchNotifications: enter\n");
            if (!this.authUri) {
                warning("fetchNotifications: no authUri (done)\n");
                this.status = STATUS_WARNING;
                return;
            }

            let message = new Soup.Message({method: 'GET', uri: this.authUri});
            if (this.lastModified) {
                // github's API is currently broken: marking a notification as read won't modify the "last-modified" header
                // so this is useless for now
                //message.request_headers.append('If-Modified-Since', this.lastModified);
            }

            this.httpSession.queue_message(message, Lang.bind(this, function (session, response) {
                this.status = STATUS_NORMAL;
                try {
                    if (response.status_code == 200 || response.status_code == 304) {
                        debug(`fetchNotifications: response code ${response.status_code}\n`);
                        if (response.response_headers.get('Last-Modified')) {
                            this.lastModified = response.response_headers.get('Last-Modified');
                        }
                        if (response.response_headers.get('X-Poll-Interval')) {
                            this.githubInterval = response.response_headers.get('X-Poll-Interval');
                        }
                        this.planFetch(this.interval(), false);
                        if (response.status_code == 200) {
                            let data = JSON.parse(response.response_body.data);
                            this.updateNotifications(data);
                            debug("fetchNotifications: 200 done\n");
                        }
                        debug("fetchNotifications: 200 or 304 done\n");
                        return;
                    }
                    if (response.status_code == 401) {
                        error('Unauthorized. Check your github handle and token in the settings');
                        this.planFetch(this.interval(), true);
                        this.status = STATUS_WARNING;
                        debug("fetchNotifications: done\n");
                        return;
                    }
                    if (!response.response_body.data && response.status_code > 400) {
                        error('HTTP error:' + response.status_code);
                        this.planFetch(this.interval(), true);
                        log("fetchNotifications: 400 done\n");
                        return;
                    }
                    // if we reach this point, none of the cases above have been triggered
                    // which likely means there was an error locally or on the network
                    // therefore we should try again in a while
                    error('HTTP error:' + response.status_code);
                    error('response error: ' + JSON.stringify(response));
                    this.planFetch(this.interval(), true);
                    this.status = STATUS_WARNING;
                    debug("fetchNotifications: done\n");
                    return;
                } catch (e) {
                    log('HTTP exception:' + e);
                    this.status = STATUS_WARNING;
                    debug("fetchNotifications: done\n");
                    return;
                }
            }));
            debug("fetchNotifications: done\n");
        }

        /**
         *
         * @param data
         */
        updateNotifications(data) {
            debug("updateNotifications: enter\n");
            let lastNotificationsCount = this.notifications.length;

            this.notifications = data;
            this.label.text = '' + data.length;
            if (data.length > 0) {
                this.status = STATUS_NORMAL;
            } else {
                this.status = STATUS_NORMAL;
            }
            this.checkVisibility();
            this.alertWithNotifications(lastNotificationsCount);
            this.setIcon();
            debug("updateNotifications: done\n");
        }

        /**
         *
         * @param lastCount
         */
        alertWithNotifications(lastCount) {
            debug("alertWithNotifications: enter\n");
            let newCount = this.notifications.length;

            if (newCount && newCount > lastCount && this.showAlertNotification) {
                try {
                    let message = 'You have ' + newCount + ' new notifications';

                    this.notify('Github Notifications', message);
                } catch (e) {
                    error("Cannot notify " + e)
                }
            }
            debug("alertWithNotifications: done\n");
        }

        /**
         *
         * @param title
         * @param message
         */
        notify(title, message) {
            debug("notify: enter\n");
            let notification;

            this.addNotificationSource();

            if (this._source && this._source.notifications.length == 0) {
                notification = new MessageTray.Notification(this._source, title, message);

                notification.setTransient(true);
                notification.setResident(false);
                notification.connect('activated', this.showBrowserUri.bind(this)); // Open on click
            } else {
                notification = this._source.notifications[0];
                notification.update(title, message, {clear: true});
            }

            this._source.notify(notification);
            debug("notify: done\n");
        }

        /**
         *
         */
        addNotificationSource() {
            debug("addNotificationSource: enter\n");
            if (this._source) {
                return;
            }

            this._source = new MessageTray.SystemNotificationSource();
            this._source.connect(
                'destroy',
                Lang.bind(this, function () {
                    this._source = null;
                })
            );
            Main.messageTray.add(this._source);
            debug("addNotificationSource: done\n");
        }
    });


class Extension {
    constructor(uuid) {
        this._indicators = []
        this._uuid = uuid;

        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }

    enable() {
        let numAccounts = Settings.get_int('num-accounts');
        for (let id = 0; id < numAccounts; id++) {
            let indicator = new Indicator(id);
            this._indicators.push(indicator);
            Main.panel.addToStatusArea(this._uuid + `-${id}`, indicator, 1);
            indicator.start()
        }
    }

    disable() {
        for (let i = 0; i < this._indicators.length; i++) {
            this._indicators[i].stop()
            this._indicators[i].destroy();
        }
    }
}

function init(meta) {
    return new Extension(meta.uuid);
}
