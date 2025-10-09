// Settings menus (submenus) for SpaceHolder (Application V2)

const MODULE_NS = 'spaceholder';

class V2Base extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    tag: 'form',
    classes: ['spaceholder', 'settings-form'],
    position: { width: 480, height: 'auto' },
    form: {
      handler: null, // to be set by subclasses
      submitOnChange: false,
      closeOnSubmit: true,
    },
  };

  static async _applySettings(map) {
    for (const [key, value] of Object.entries(map)) {
      await game.settings.set(MODULE_NS, key, value);
    }
  }
}

export class TokenPointerSettingsApp extends V2Base {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-tokenpointer-settings',
    window: { title: 'Token Pointer Settings' },
  };

  static PARTS = {
    form: { template: 'systems/spaceholder/templates/settings/tokenpointer.hbs' },
  };

  static async onSubmit(event, form, formData) {
    const data = formData.object; // flattened object
    const map = {};
    map['tokenpointer.color'] = String(data['tokenpointer.color']);
    map['tokenpointer.distance'] = Number(data['tokenpointer.distance']);
    map['tokenpointer.scale'] = Number(data['tokenpointer.scale']);
    map['tokenpointer.mode'] = Number(data['tokenpointer.mode']);
    map['tokenpointer.combatOnly'] = !!data['tokenpointer.combatOnly'];
    map['tokenpointer.hideOnDead'] = !!data['tokenpointer.hideOnDead'];
    map['tokenpointer.lockToGrid'] = !!data['tokenpointer.lockToGrid'];
    map['tokenpointer.flipHorizontal'] = !!data['tokenpointer.flipHorizontal'];
    map['tokenpointer.pointerType'] = String(data['tokenpointer.pointerType']);
    await V2Base._applySettings(map);
  }

  static DEFAULT_OPTIONS_FORM = (() => {
    const opts = foundry.utils.deepClone(this.DEFAULT_OPTIONS);
    opts.form.handler = this.onSubmit;
    return opts;
  })();

  static get defaultOptions() { return this.DEFAULT_OPTIONS_FORM; }

  async _prepareContext() {
    return {
      color: (game.settings.get(MODULE_NS, 'tokenpointer.color')?.css) ?? '#000000',
      distance: game.settings.get(MODULE_NS, 'tokenpointer.distance'),
      scale: game.settings.get(MODULE_NS, 'tokenpointer.scale'),
      mode: game.settings.get(MODULE_NS, 'tokenpointer.mode'),
      combatOnly: game.settings.get(MODULE_NS, 'tokenpointer.combatOnly'),
      hideOnDead: game.settings.get(MODULE_NS, 'tokenpointer.hideOnDead'),
      lockToGrid: game.settings.get(MODULE_NS, 'tokenpointer.lockToGrid'),
      flipHorizontal: game.settings.get(MODULE_NS, 'tokenpointer.flipHorizontal'),
      pointerType: game.settings.get(MODULE_NS, 'tokenpointer.pointerType'),
    };
  }
}

export class TokenRotatorSettingsApp extends V2Base {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: 'spaceholder-tokenrotator-settings',
    window: { title: 'Token Rotator Settings' },
  };

  static PARTS = {
    form: { template: 'systems/spaceholder/templates/settings/tokenrotator.hbs' },
  };

  static async onSubmit(event, form, formData) {
    const data = formData.object;
    const map = {};
    map['tokenrotator.altSnapByDefault'] = !!data['tokenrotator.altSnapByDefault'];
    map['tokenrotator.smoothRotation'] = !!data['tokenrotator.smoothRotation'];
    map['tokenrotator.fastPreview'] = !!data['tokenrotator.fastPreview'];
    map['tokenrotator.rotationUpdateFrequency'] = Number(data['tokenrotator.rotationUpdateFrequency']);
    await V2Base._applySettings(map);
  }

  static DEFAULT_OPTIONS_FORM = (() => {
    const opts = foundry.utils.deepClone(this.DEFAULT_OPTIONS);
    opts.form.handler = this.onSubmit;
    return opts;
  })();

  static get defaultOptions() { return this.DEFAULT_OPTIONS_FORM; }

  async _prepareContext() {
    return {
      altSnapByDefault: game.settings.get(MODULE_NS, 'tokenrotator.altSnapByDefault'),
      smoothRotation: game.settings.get(MODULE_NS, 'tokenrotator.smoothRotation'),
      fastPreview: game.settings.get(MODULE_NS, 'tokenrotator.fastPreview'),
      rotationUpdateFrequency: game.settings.get(MODULE_NS, 'tokenrotator.rotationUpdateFrequency'),
    };
  }
}

export function registerSpaceholderSettingsMenus() {
  // Submenus under system settings (Token Rotator only)
  game.settings.registerMenu(MODULE_NS, 'tokenrotator-menu', {
    name: 'Token Rotator', label: 'Configure', hint: 'Configure Token Rotator settings',
    type: TokenRotatorSettingsApp, restricted: false,
  });
}
