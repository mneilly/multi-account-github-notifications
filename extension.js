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
const ByteArray = imports.byteArray;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Soup = imports.gi.Soup;

const Settings = ExtensionUtils.getSettings('com.github.mneilly.multi-account-github-notifications');
const DEBUG = true;
let { PACKAGE_VERSION } = imports.misc.config;
PACKAGE_VERSION = Number(PACKAGE_VERSION);

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

const Indicator =
GObject.registerClass(
    /**
     * The main indicator widget that gets put in the status bar.
     */
    class Indicator extends PanelMenu.Button {

        // static lastIconSet = 0; // stores the last loaded icon set number

        _init(id) {
            debug("_init: enter\n");
            super._init(0.0, _(`Github Notification ${id}`));

            this.accountId = id;
            this.notifications = [];
            this.status = STATUS_NORMAL;
            this.retryAttempts = 0;
            this.authUri = null;

            this.color = 'black'
            this.lastIconSet = 0;

            // Get settings needed for init
            let login = Settings.get_strv('login')[this.accountId];
            let filter = Settings.get_string('filter');
            this.iconSet = Settings.get_int('icon-set');

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
            // debug(`domain: ${this.domain}\n`);
            this.token = Settings.get_strv('token')[this.accountId];
            // debug(`token: ${this.token}\n`);
            this.login = Settings.get_strv('login')[this.accountId];
            // debug(`login: ${this.login}\n`);
            this.color = Settings.get_strv('color')[this.accountId];
            // debug(`color: ${this.color}\n`);
            this.command = Settings.get_strv('command')[this.accountId];
            // debug(`command: ${this.command}\n`);
            this.iconSet = Settings.get_int('icon-set');
            // debug(`iconSet: ${this.iconSet}\n`);
            this.hideWidget = Settings.get_boolean('hide-widget');
            // debug(`hideWidget: ${this.hideWidget}\n`);
            this.hideCount = Settings.get_boolean('hide-notification-count');
            // debug(`hideCount: ${this.hideCount}\n`);
            this.refreshInterval = Settings.get_int('refresh-interval');
            // debug(`refreshInterval: ${this.refreshInterval}\n`);
            this.githubInterval = this.refreshInterval;
            // debug(`githubInterval: ${this.githubInterval}\n`);
            this.showAlertNotification = Settings.get_boolean('show-alert');
            // debug(`showAlertNotification: ${this.showAlertNotification}\n`);
            this.filter = Settings.get_string('filter');
            // debug(`filter: ${this.filter}\n`);
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

        getUri(use_api=true) {
            let url = `https://api.${this.domain}/notifications`;
            if (!use_api) {
                url = `https://${this.domain}/notifications`;
            }
            if (this.filter !== "none") {
                url = `${url}?query=reason%3A${this.filter}`;
            }
            let uri;
            if (PACKAGE_VERSION >= 43) {
                uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
            } else {
                uri = new Soup.URI(url);
            }
            return uri;
        }

        getUrl(uri) {
            let url;
            if (PACKAGE_VERSION >= 43) {
                url = uri.to_string();
            } else {
                url = uri.toString();
            }
            return url;
        }

        /**
         * Show notificiations in the users browser based on the selected filter.
         */
        showBrowserUri() {
            debug("showBrowserUri: enter\n");
            let uri = this.getUri(false);
            let url = this.getUrl(uri);
            try {
                if (this.command) {
                    let cmd = this.command + " " + url;
                    GLib.spawn_command_line_sync(cmd);
                    // const proc = Gio.Subprocess.new(
                    //     this.command.split(" "),
                    //     Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                    // );
                } else {
                    let timestamp = PACKAGE_VERSION >= 43 ? Gtk.CURRENT_TIME : Gtk.get_current_event_time();
                    Gtk.show_uri(null, url, timestamp);
                }
            } catch (e) {
                error("Cannot open uri " + e)
            }
            debug("showBrowserUri: done\n");
        }

        getHost(uri) {
            if (PACKAGE_VERSION >= 43) {
                debug(uri.get_hostname());
                return uri.get_hostname();
            } else {
                debug(uri.get_host());
                return uri.get_host();
            }
        }

        /**
         *
         */

        initHttp() {
            this.status = STATUS_NORMAL;
            if (!this.login || !this.token) {
                this.status = STATUS_WARNING;
                return;
            }

            let uri = this.getUri();
            this.authUri = uri;

            if (this.httpSession) {
                this.httpSession.abort();
            } else {
                this.httpSession = new Soup.Session();
                this.httpSession.user_agent =
                    'gnome-shell-extension github notification via libsoup';

                if (PACKAGE_VERSION >= 43) {
                    this.auth = new Soup.AuthBasic();
                    this.auth.authenticate(this.login, this.token);
                } else {
                    this.authUri.set_user(this.login);
                    this.authUri.set_password(this.token);
                    this.auth = new Soup.AuthBasic({
                        host: this.getHost(uri),
                        realm: 'Github Api',
                    });
                    this.authManager = new Soup.AuthManager();
                    this.authManager.use_auth(this.authUri, this.auth);
                    Soup.Session.prototype.add_feature.call(
                        this.httpSession,
                        this.authManager
                    );
                }
            }
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

        getLastModified(response) {
            if (PACKAGE_VERSION >= 43) {
                if (response.get_response_headers().get_one('Last-Modified')) {
                    return response.get_response_headers().get_one('Last-Modified');
                }
            } else {
                if (response.response_headers.get('Last-Modified')) {
                    return response.response_headers.get('Last-Modified');
                }
            }
            return null;
        }

        getXPollInterval(response) {
            if (PACKAGE_VERSION >= 43) {
                if (response.get_response_headers().get_one('X-Poll-Interval')) {
                    return response
                        .get_response_headers()
                        .get_one('X-Poll-Interval');
                }
            } else {
                if (response.response_headers.get('X-Poll-Interval')) {
                    return response.response_headers.get('X-Poll-Interval');
                }
            }
            return null;
        }

        getMessageBody(r) {
            let body;
            if (PACKAGE_VERSION >= 43) {
                body = this.httpSession.send_and_read_finish(r);
                body = body.get_data();
                body = ByteArray.toString(body);
            } else {
                body = r.response_body.data;
            }
            return body;
        }

        processResponse(status, message, response) {
            try {
                if (status === 200 || status === 304) {
                    this.lastModified = this.getLastModified(message);
                    this.githubInterval = this.getXPollInterval(message);
                    this.planFetch(this.interval(), false);
                    if (status === 200) {
                        let data = JSON.parse(this.getMessageBody(response));
                        this.updateNotifications(data);
                    }
                } else if (status === 401) {
                    error(
                        'Unauthorized. Check your github handle and token in the settings'
                    );
                    this.planFetch(this.interval(), true);
                    this.label.set_text('!');
                } else if (!message.message_body.data && status > 400) {
                    error('HTTP error:' + message.get_status());
                    this.planFetch(this.interval(), true);
                } else {
                    // if we reach this point, none of the cases above have been triggered
                    // which likely means there was an error locally or on the network
                    // therefore we should try again in a while
                    error('HTTP error:' + status);
                    error('message error: ' + JSON.stringify(message));
                    this.planFetch(this.interval(), true);
                    this.label.set_text('!');
                }
            } catch (e) {
                error('HTTP exception:' + e);
            }
        }

        /**
         *
         */
        fetchNotifications() {
            if (this.authUri === null) {
                return;
            }

            if (PACKAGE_VERSION >= 43) {
                this.fetchNotificationsGnome43();
            } else {
                this.fetchNotificationsPreGnome43();
            }
        }

        fetchNotificationsGnome43() {
            let message = new Soup.Message({ method: 'GET', uri: this.authUri });
            if (this.lastModified) {
                // github's API is currently broken: marking a notification as read won't modify the "last-modified" header
                // so this is useless for now
                //message.request_headers.append('If-Modified-Since', this.lastModified);
            }

            message.request_headers.append(
                'Authorization',
                this.auth.get_authorization(message)
            );


            this.httpSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (_, response) => {
                    let status = message.get_status();
                    this.processResponse(status, message, response);
                }
            );
        }

        fetchNotificationsPreGnome43() {
            let message = new Soup.Message({ method: 'GET', uri: this.authUri });
            if (this.lastModified) {
                // github's API is currently broken: marking a notification as read won't modify the "last-modified" header
                // so this is useless for now
                //message.request_headers.append('If-Modified-Since', this.lastModified);
            }

            this.httpSession.queue_message(message, (_, response) => {
                let status = response.status_code;
                this.processResponse(status, message, response);
                /*
                try {

                if (status === 200 || status === 304) {
                    this.lastModified = this.getLastModified(response);
                    this.lastModified = this.getXPollInterval(response);
                    this.planFetch(this.interval(), false);
                    if (status === 200) {
                        let data = JSON.parse(this.getMessageBody(response));
                        this.updateNotifications(data);
                    }
                    return;
                }
                if (status === 401) {
                    error(
                        'Unauthorized. Check your github handle and token in the settings'
                    );
                    this.planFetch(this.interval(), true);
                    this.label.set_text('!');
                    return;
                }
                if (!response.response_body.data && status > 400) {
                    error('HTTP error:' + status);
                    this.planFetch(this.interval(), true);
                    return;
                }
                // if we reach this point, none of the cases above have been triggered
                // which likely means there was an error locally or on the network
                // therefore we should try again in a while
                error('HTTP error:' + status);
                error('response error: ' + JSON.stringify(response));
                this.planFetch(this.interval(), true);
                this.label.set_text('!');
            } catch (e) {
                error('HTTP exception:' + e);
            }
                 */
            });
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
