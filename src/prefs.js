// brightness-slider - Control the display's brightness via an alpha channel.
// Copyright (C) 2019-2022 Philippe Troin (F-i-f on Github)
// Copyright (C) 2023 Joel Kitching (jkitching on Github)
// Copyright (C) 2026 Shantanu Baviskar (shantanub08 on Github)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Utils from './utils.js';

export default class BrightnessSliderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(new PreferencesPage(this.getSettings(), this.metadata));
    }
}

const PreferencesPage = GObject.registerClass(class PreferencesPage extends Adw.PreferencesPage {
    constructor(settings, metadata) {
        super();

        this._settings = settings;
        this._metadata = metadata;

        {
            const group = new Adw.PreferencesGroup();

            this.enabled_control = new Adw.SwitchRow({
                title: _('Control overlay brightness independently'),
                subtitle: _('Show a separate slider in the quick settings menu.'),
            });
            // Inverted binding: when switch is ON, use-backlight is false
            this._settings.bind('use-backlight', this.enabled_control, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
            group.add(this.enabled_control);

            const monitorsModel = new Gtk.StringList();
            monitorsModel.append(_('All'));
            monitorsModel.append(_('Built-in'));
            monitorsModel.append(_('External'));
            this.monitors_control = new Adw.ComboRow({
                title: _('Monitor(s):'),
                subtitle: this._getDescription('monitors'),
                model: monitorsModel,
            });
            this.monitors_control.connect('notify::selected', () => {
                this._settings.set_enum('monitors', this.monitors_control.selected);
            });
            this._settings.connect('changed::monitors', () => {
                this.monitors_control.set_selected(this._settings.get_enum('monitors'));
            });
            group.add(this.monitors_control);

            this.builtinMonitorControl = new Adw.ComboRow({
                title: _('Built-in monitor:'),
                subtitle: this._getDescription('builtin-monitor'),
            });
            Utils.newDisplayConfig(this._metadata['path'], (function(proxy, error) {
                if (error) {
                    console.log('Cannot get DisplayConfig: ' + error);
                    return;
                }
                this.displayConfigProxy = proxy;
                this._bindBuiltinMonitorControl();
                this.displayConfigProxy.connectSignal('MonitorsChanged', this._refreshMonitors.bind(this));
                this._refreshMonitors();
            }).bind(this));
            group.add(this.builtinMonitorControl);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup();

            this.min_brightness_control = new Adw.ActionRow({
                title: _('Minimum brightness (0..1):'),
                subtitle: this._getDescription('min-brightness'),
            });
            {
                const scale = new Gtk.Scale({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    adjustment: new Gtk.Adjustment({
                        lower: 0.0, upper: 1.0,
                        step_increment: 0.01, page_increment: 0.1,
                        value: this._settings.get_double('min-brightness'),
                    }),
                    digits: 2,
                    draw_value: true,
                    value_pos: Gtk.PositionType.RIGHT,
                    hexpand: true,
                    width_request: 200,
                    valign: Gtk.Align.CENTER,
                });
                scale.connect('value-changed', () => {
                    this._settings.set_double('min-brightness', scale.get_value());
                });
                this._settings.connect('changed::min-brightness', () => {
                    scale.set_value(this._settings.get_double('min-brightness'));
                });
                this.min_brightness_control.add_suffix(scale);
            }
            group.add(this.min_brightness_control);

            this.clone_mouse_control = new Adw.SwitchRow({
                title: _('Mouse cursor brightness control:'),
                subtitle: this._getDescription('clone-mouse'),
            });
            this._settings.bind('clone-mouse', this.clone_mouse_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.clone_mouse_control);

            this.debug_control = new Adw.SwitchRow({
                title: _('Debug:'),
                subtitle: this._getDescription('debug'),
            });
            this._settings.bind('debug', this.debug_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.debug_control);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup({
                title: _('Desktop & External Displays (DDC/CI)'),
                description: _('Control hardware brightness & contrast simultaneously on supported desktop monitors via DDC/CI.'),
            });

            this.ddc_control = new Adw.SwitchRow({
                title: _('Enable DDC/CI hardware control'),
                subtitle: _('Adjust physical monitor brightness & contrast using ddcutil.'),
            });
            this._settings.bind('ddc-enabled', this.ddc_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.ddc_control);

            this.software_dim_ratio_control = new Adw.ActionRow({
                title: _('Software dimming space on slider:'),
                subtitle: _('Portion of slider allocated to software dimming when hardware brightness is at 0.'),
            });
            {
                const scale = new Gtk.Scale({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    adjustment: new Gtk.Adjustment({
                        lower: 0.05, upper: 0.50,
                        step_increment: 0.01, page_increment: 0.05,
                        value: this._settings.get_double('software-dim-ratio'),
                    }),
                    digits: 2,
                    draw_value: true,
                    value_pos: Gtk.PositionType.RIGHT,
                    hexpand: true,
                    width_request: 200,
                    valign: Gtk.Align.CENTER,
                });
                scale.connect('value-changed', () => {
                    this._settings.set_double('software-dim-ratio', scale.get_value());
                });
                this._settings.connect('changed::software-dim-ratio', () => {
                    scale.set_value(this._settings.get_double('software-dim-ratio'));
                });
                this.software_dim_ratio_control.add_suffix(scale);
            }
            group.add(this.software_dim_ratio_control);

            this.sync_monitors_control = new Adw.SwitchRow({
                title: _('Synchronize all monitors'),
                subtitle: _('Adjust brightness and contrast across all monitors in unison.'),
            });
            this._settings.bind('sync-monitors', this.sync_monitors_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.sync_monitors_control);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup({
                title: _('Keyboard shortcuts'),
                description: _('Default shortcuts use Shift + hardware brightness keys. Click Set and press a key combination to change one, or Clear to disable it. Bare media keys and function keys are allowed; other keys need a modifier.'),
            });

            group.add(this._buildShortcutRow(_('Increase brightness'), 'brightness-up'));
            group.add(this._buildShortcutRow(_('Decrease brightness'), 'brightness-down'));

            group.add(this._buildStepRow(
                _('Software step size:'),
                _('Portion of the software dimming zone moved by each shortcut press.'),
                'shortcut-step-software'));
            group.add(this._buildStepRow(
                _('Hardware step size:'),
                _('Portion of the hardware brightness zone moved by each shortcut press.'),
                'shortcut-step-hardware'));

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup();

            const versionString = this._metadata['version'] + ' / git ' + this._metadata['vcs_revision'];
            this.version_label = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' + _('Version') +
                    ' ' + versionString + '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
            });
            group.add(this.version_label);

            this.link_label = new Gtk.Label({
                use_markup: true,
                label: '<span size="small"><a href="' + this._metadata.url + '">' +
                    this._metadata.url + '</a></span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
            });
            group.add(this.link_label);

            const copyright1 = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' +
                    _('Copyright © 2019-2022 Philippe Troin (<a href="https://github.com/F-i-f">F-i-f</a> on GitHub)') +
                    '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
                margin_top: this.margin_bottom,
            });
            const copyright2 = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' +
                    _('Copyright © 2022-2024 Joel Kitching (<a href="https://github.com/jkitching">jkitching</a> on GitHub)') +
                    '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
                margin_top: this.margin_bottom,
            });
            const copyright3 = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' +
                    _('Copyright © 2026 Shantanu Baviskar (<a href="https://github.com/shantanub08">shantanub08</a> on GitHub)') +
                    '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
                margin_top: this.margin_bottom,
            });

            group.add(copyright1);
            group.add(copyright2);
            group.add(copyright3);

            this.add(group);
        }
    }

    _getDescription(name) {
        return _(this._settings.settings_schema.get_key(name).get_description());
    }

    _buildShortcutRow(title, settingKey) {
        const row = new Adw.ActionRow({ title });

        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });

        const refresh = () => {
            const vals = this._settings.get_strv(settingKey);
            shortcutLabel.accelerator = vals.length ? vals[0] : '';
        };
        refresh();
        this._settings.connect(`changed::${settingKey}`, refresh);

        const setButton = new Gtk.Button({
            label: _('Set…'),
            valign: Gtk.Align.CENTER,
        });
        setButton.add_css_class('flat');
        setButton.connect('clicked', () => {
            this._openShortcutDialog(title, settingKey, row.get_root());
        });

        const clearButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
        });
        clearButton.add_css_class('flat');
        clearButton.connect('clicked', () => this._settings.set_strv(settingKey, []));

        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('flat');
        resetButton.connect('clicked', () => this._settings.reset(settingKey));

        row.add_suffix(shortcutLabel);
        row.add_suffix(setButton);
        row.add_suffix(clearButton);
        row.add_suffix(resetButton);
        return row;
    }

    _buildStepRow(title, subtitle, settingKey) {
        const row = new Adw.ActionRow({ title, subtitle });
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 20,
                step_increment: 1, page_increment: 5,
                value: this._settings.get_double(settingKey) * 100,
            }),
            digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 200,
            valign: Gtk.Align.CENTER,
        });
        scale.connect('value-changed', () => {
            this._settings.set_double(settingKey, scale.get_value() / 100);
        });
        this._settings.connect(`changed::${settingKey}`, () => {
            scale.set_value(this._settings.get_double(settingKey) * 100);
        });
        const percent = new Gtk.Label({
            label: '%',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(scale);
        row.add_suffix(percent);
        return row;
    }

    _openShortcutDialog(title, settingKey, parent) {
        const dialog = new Gtk.Window({
            title: _('Set Shortcut'),
            transient_for: parent instanceof Gtk.Window ? parent : null,
            modal: true,
            resizable: false,
            default_width: 420,
        });
        dialog.set_titlebar(new Gtk.HeaderBar());

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });

        const heading = new Gtk.Label({
            label: title,
            xalign: 0,
        });
        heading.add_css_class('title-3');
        box.append(heading);

        const prompt = new Gtk.Label({
            label: _('Press the key combination you want to use.'),
            xalign: 0,
            wrap: true,
        });
        box.append(prompt);

        const error = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
        });
        error.add_css_class('error');
        box.append(error);

        const hint = new Gtk.Label({
            label: _('If nothing happens, a system shortcut may already be using this key.'),
            xalign: 0,
            wrap: true,
        });
        hint.add_css_class('dim-label');
        box.append(hint);

        const cancelButton = new Gtk.Button({
            label: _('Cancel'),
            halign: Gtk.Align.END,
        });
        cancelButton.connect('clicked', () => dialog.close());
        box.append(cancelButton);

        dialog.set_child(box);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            if (this._isModifierKey(keyval))
                return true;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!this._isBareShortcutKey(keyval) && mask === 0) {
                error.label = _('Hold Ctrl, Alt, Shift or Super, or use a media or function key.');
                error.visible = true;
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mask)) {
                error.label = _('That key combination cannot be used as a shortcut.');
                error.visible = true;
                return true;
            }

            this._settings.set_strv(settingKey,
                [Gtk.accelerator_name(keyval, mask)]);
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present();
        cancelButton.grab_focus();
    }

    _isModifierKey(keyval) {
        return [
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
            Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
        ].includes(keyval);
    }

    _isBareShortcutKey(keyval) {
        // Media/XF86 keys, function keys, and other GDK special keys are
        // safe to bind without a modifier.  accelerator_valid() still
        // rejects the ones GTK cannot express.
        return (keyval >= 0x1008FF00 && keyval <= 0x1008FFFF) ||
            (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) ||
            (keyval >= 0xFF00 && keyval <= 0xFFFF);
    }

    _bindBuiltinMonitorControl() {
        this.builtin_monitor_control_signal = this.builtinMonitorControl.connect('notify::selected', () => {
            this._settings.set_string('builtin-monitor', this.builtinMonitorControl.selected_item.string);
        });
        this.builtin_monitor_settings_signal = this._settings.connect('changed::builtin-monitor', () => {
            this._refreshMonitors();
        });
    }

    _unbindBuiltinMonitorControl() {
        this.builtinMonitorControl.disconnect(this.builtin_monitor_control_signal);
        this._settings.disconnect(this.builtin_monitor_settings_signal);
    }

    _refreshMonitors() {
        Utils.getMonitorConfig(this.displayConfigProxy, (result, error) => {
            if (error) {
                console.log('Cannot get DisplayConfig: ' + error);
                return;
            }
            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            const builtinMonitorModel = new Gtk.StringList();
            this._unbindBuiltinMonitorControl();
            let builtinFound = false;
            let builtinIdx = 0;
            for (let i = 0; i < result.length; i++) {
                const displayName = result[i][0];
                if (displayName == builtinMonitorName) {
                    builtinFound = true;
                    builtinIdx = i;
                }
                builtinMonitorModel.append(displayName);
            }
            if (!builtinFound && builtinMonitorName != '') {
                builtinMonitorModel.append(builtinMonitorName);
                builtinIdx = result.length;
            }
            this.builtinMonitorControl.set_model(builtinMonitorModel);
            this.builtinMonitorControl.set_selected(builtinIdx);
            this._bindBuiltinMonitorControl();
        });
    }
});
