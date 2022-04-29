const { GObject, Gio, Gtk, Gdk, GLib } = imports.gi;

const Config = imports.misc.config;
const [major] = Config.PACKAGE_VERSION.split('.');
const shellVersion = Number.parseInt(major);

let PREFS_UI = "prefs.ui";
let ACCOUNT_FRAME_UI = "account_frame.ui"
if (shellVersion < 40) {
    PREFS_UI = "ui3/prefs.ui"
    ACCOUNT_FRAME_UI = "ui3/account_frame.ui";
}

const ID = "com.github.mneilly.multi-account-github-notifications";

const GETTEXT_DOMAIN = 'multi-account-github-notifications';

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Lang = imports.lang;

const PrefsWidget = GObject.registerClass({
    GTypeName: 'PrefsWidget',
    Template: Me.dir.get_child(PREFS_UI).get_uri(),
    InternalChildren: [
        'accountsSubBox',
        'addAccountButton',
        'deleteAccountButton',
        'participatingOnly',
        'hideIfNone',
        'hideCount',
        'showAlert'
    ]
}, class PrefsWidget extends Gtk.Box {
    _init(settings) {
        log("PrefsWidget: _init enter\n");
        super._init();
        this.settings = ExtensionUtils.getSettings('com.github.mneilly.multi-account-github-notifications');
        this.deleteStates = new Array(5).fill(false);
        this.accountFrames = new Array(5).fill(null);

        logToFile(`_init(): deleteStates: ${this.deleteStates}\n`);
        logToFile("_init(): accountFrames:\n");
        logToFile(this.accountFrames);

        // Add account frames for existing accounts
        let index = this.settings.get_int('num-accounts');
        for (let i=0; i < index; i++) {
            this.addAccountFrame(i);
        }

        // Setup callbacks for adding and removing accounts
        this._addAccountButton.connect('clicked', Lang.bind(this, this.addAccount));
        this._deleteAccountButton.connect('clicked', Lang.bind(this, this.deleteAccounts));
        // this.settings.bind('filter', this._messageFilter, 'state', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('hide-widget', this._hideIfNone, 'state', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('hide-notification-count', this._hideCount, 'state', Gio.SettingsBindFlags.DEFAULT);
        this.settings.bind('show-alert', this._showAlert, 'state', Gio.SettingsBindFlags.DEFAULT);
        log("PrefsWidget: _init done\n");
    }

    addAccount() {
        log("PrefsWidget: addAccount enter\n");
        let index = this.settings.get_int('num-accounts');
        this.addAccountFrame(index);
        this.settings.set_int('num-accounts', index + 1);
        this.deleteStates[index] = false;
        logToFile(`addAccount(): deleteStates: ${this.deleteStates}\n`);
        log("PrefsWidget: addAccount done\n");
    }

    addAccountFrame(index)  {
        log("PrefsWidget: addAccountFrame enter\n");
        this.accountFrames[index] = new AccountFrame(this, index);
        if (shellVersion < 40) {
            this._accountsSubBox.pack_start(this.accountFrames[index], true, true, 0);
        } else {
            this._accountsSubBox.append(this.accountFrames[index]);
        }
        logToFile("addAccountFrame(): accountFrames:\n");
        logToFile(this.accountFrames);
        log("PrefsWidget: addAccountFrame done\n");
    }

    deleteAccounts() {
        log("PrefsWidget: deleteAccounts enter\n");
        // Copy current deleteStates since cannot modify it while looping
        let newDeleteStates = [...this.deleteStates];
        // Index into spliced arrays; only incremented when current index is not deleted
        let index = 0;
        let numAccounts = this.settings.get_int('num-accounts');


        for (let ds of this.deleteStates) {
            if (ds) {
                logToFile(`deleteAccounts(): deleting: ${this.accountFrames[index]}\n`);
                // Remove the account frame UI
                this._accountsSubBox.remove(this.accountFrames[index]);
                // Remove all preference keys for the item
                for (let key of ['login', 'domain', 'token', 'command', 'color'].values()) {
                    let values = this.settings.get_strv(key);
                    values.splice(index, 1)
                    this.settings.set_strv(key, values);
                }
                // Adjust the list of account frames and delete states
                this.accountFrames.splice(index, 1);
                newDeleteStates.splice(index, 1);
                numAccounts--;
                // Adjust indexes of account frames after the deleted one
                for (let i = index; i < numAccounts; i++) {
                    this.accountFrames[i].index = i;
                    this.accountFrames[i]._accountLabel.set_text(`Account ${index + 1}`)
                }
            } else {
                index++;
            }
        }
        this.deleteStates = [...newDeleteStates];
        this.settings.set_int('num-accounts', numAccounts);
        logToFile(`deleteAccounts(): deleteStates: ${this.deleteStates}\n`);
        logToFile("deleteAccounts(): accountFrames:\n");
        logToFile(this.accountFrames);
        let indexes = this.accountFrames.map(x => x.index);
        logToFile(`deleteAccounts(): frame indexes: ${indexes}\n`);
        log("PrefsWidget: deleteAccounts done\n");
    }
});

const AccountFrame = GObject.registerClass({
    GTypeName: 'AccountFrame',
    Template: Me.dir.get_child(ACCOUNT_FRAME_UI).get_uri(),
    InternalChildren: [
        'loginEntry',
        'deleteCheckButton',
        'tokenEntry',
        'domainEntry',
        'commandEntry',
        'colorButton',
        'accountLabel'
    ]

}, class AccountFrame extends Gtk.Box {
    _init(top, index) {
        log("AccountFrame: _init enter\n");
        super._init();
        this.settings = top.settings;
        this.index = index;
        this._accountLabel.set_text(`Account ${this.index + 1}`)
        this.top = top;
        logToFile(`AccountFrame::_init(): ${top}`);
        this.prefObjs = {
            'login': this._loginEntry,
            'domain': this._domainEntry,
            'token': this._tokenEntry,
            'command': this._commandEntry,
        };
        this.initPrefs();
        log("AccountFrame: _init done\n");
    }

    initPrefs() {
        log("AccountFrame: initPrefs enter\n");
        for (let key in this.prefObjs) {
            // fill with current value
            let value = this.settings.get_strv(key)[this.index] || "";
            this.prefObjs[key].set_text(value);

            // Set callback for changes
            this.prefObjs[key].connect('changed', Lang.bind(this, function (obj) {
                let values = this.settings.get_strv(key);
                values[this.index] = obj.get_text();
                this.settings.set_strv(key, values);
            }));
        }

        // fill with current color
        let rgba = new Gdk.RGBA();
        try {
            rgba.parse(this.settings.get_strv('color')[this.index]);
        } catch (e) {
            rgba.parse('white');
        } finally {
            this._colorButton.set_rgba(rgba);
        }

        let palette = this.settings.get_strv('palette')
        let paletteRGBA = Array(10).fill(null);
        for (let i=0; i < palette.length; i++) {
            paletteRGBA[i] = new Gdk.RGBA();
            paletteRGBA[i].parse(palette[i]);
        }
        this._colorButton.add_palette(0, 10, paletteRGBA);

        // Set callback for changes
        this._colorButton.connect('notify::rgba', Lang.bind(this, function(button) {
            let values = this.settings.get_strv('color');
            let color = button.get_rgba().to_string();
            values[this.index] = color;
            updateCss(color, this.index);
            this.settings.set_strv('color', values);
        }));

        // Store state of delete check buttons for use when delete button is
        // clicked
        this._deleteCheckButton.connect('toggled', Lang.bind(this, this.deleteAccount));
        log("AccountFrame: initPrefs done\n");
    }

    deleteAccount(obj) {
        log("AccountFrame: deleteAccount enter\n");
        logToFile(`_deleteCheckButton(): obj: ${obj.parent.parent.parent}`);
        this.top.deleteStates[this.index] = obj.get_active();
        logToFile(`_deleteCheckButton(): deleteStates: ${this.top.deleteStates}`);
        log("AccountFrame: deleteAccount done\n");
    }
});

function logToFile(data) {
    let path = GLib.build_filenamev([GLib.get_user_cache_dir(), "multi-account-gh-notify.log"]);
    let file = Gio.File.new_for_path(path);
    let stream = file.append_to(Gio.FileCreateFlags.NONE, null);
    if (Array.isArray(data)) {
        for (let val of data) {
            if (val === null) {
                stream.write("\tnull\n", null);
            } else {
                stream.write(`\t${val.toString()}`, null);
                stream.write("\n", null);
            }
        }
    } else {
        stream.write(`${data.toString()}\n`, null);
    }
    stream.close(null);
    // let [success, tag] = file.replace_contents(
    //     text,
    //     null,
    //     false,
    //     Gio.FileCreateFlags.REPLACE_DESTINATION,
    //     null
    // );
}

function updateCss(data, index) {
    log("Prefs: updateCss enter\n");
    let path = GLib.build_filenamev([Me.dir.get_path(), "colors.css"]);
    let file = Gio.File.new_for_path(path);
    let [success, colorsCss] = file.load_contents(null);
    let newEntry = `.gh-account${index}-style { border-top: 2px solid ${data}; }\n`;
    let re = new RegExp(`.gh-account${index}-style.*?\n`, "gm");
    //if (colorsCss instanceof Uint8Array) {
    colorsCss = imports.byteArray.toString(colorsCss).replace(re, newEntry);
    log(`[XXXXXX]: ${colorsCss}`);
    let [success2, tag] = file.replace_contents(colorsCss, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    log("Prefs: updateCss done\n");
}

function buildPrefsWidget() {
    return new PrefsWidget();
}

function init() {
    ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
}
