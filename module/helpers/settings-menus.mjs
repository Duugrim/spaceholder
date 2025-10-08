// Settings menus (submenus) for SpaceHolder

const MODULE_NS = 'spaceholder';

class BaseSettingsForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      width: 480,
      height: 'auto',
      closeOnSubmit: true,
      submitOnChange: false,
      submitOnClose: false,
      resizable: false,
      classes: ['spaceholder', 'settings-form'],
    });
  }

  async _updateSettings(map) {
    for (const [key, value] of Object.entries(map)) {
      await game.settings.set(MODULE_NS, key, value);
    }
  }
}

export class TokenPointerSettingsApp extends BaseSettingsForm {
  static get defaultOptions() {
    const opts = super.defaultOptions;
    return { ...opts, id: 'spaceholder-tokenpointer-settings', title: 'Token Pointer Settings', template: 'systems/spaceholder/templates/settings/tokenpointer.hbs' };
  }

  async getData() {
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

  async _updateObject(_event, formData) {
    const map = {};
    // normalize data
    map['tokenpointer.color'] = String(formData['tokenpointer.color']);
    map['tokenpointer.distance'] = Number(formData['tokenpointer.distance']);
    map['tokenpointer.scale'] = Number(formData['tokenpointer.scale']);
    map['tokenpointer.mode'] = Number(formData['tokenpointer.mode']);
    map['tokenpointer.combatOnly'] = !!formData['tokenpointer.combatOnly'];
    map['tokenpointer.hideOnDead'] = !!formData['tokenpointer.hideOnDead'];
    map['tokenpointer.lockToGrid'] = !!formData['tokenpointer.lockToGrid'];
    map['tokenpointer.flipHorizontal'] = !!formData['tokenpointer.flipHorizontal'];
    map['tokenpointer.pointerType'] = String(formData['tokenpointer.pointerType']);
    await this._updateSettings(map);
  }
}

export class TokenRotatorSettingsApp extends BaseSettingsForm {
  static get defaultOptions() {
    const opts = super.defaultOptions;
    return { ...opts, id: 'spaceholder-tokenrotator-settings', title: 'Token Rotator Settings', template: 'systems/spaceholder/templates/settings/tokenrotator.hbs' };
  }

  async getData() {
    return {
      altSnapByDefault: game.settings.get(MODULE_NS, 'tokenrotator.altSnapByDefault'),
      smoothRotation: game.settings.get(MODULE_NS, 'tokenrotator.smoothRotation'),
      fastPreview: game.settings.get(MODULE_NS, 'tokenrotator.fastPreview'),
      rotationUpdateFrequency: game.settings.get(MODULE_NS, 'tokenrotator.rotationUpdateFrequency'),
    };
  }

  async _updateObject(_event, formData) {
    const map = {};
    map['tokenrotator.altSnapByDefault'] = !!formData['tokenrotator.altSnapByDefault'];
    map['tokenrotator.smoothRotation'] = !!formData['tokenrotator.smoothRotation'];
    map['tokenrotator.fastPreview'] = !!formData['tokenrotator.fastPreview'];
    map['tokenrotator.rotationUpdateFrequency'] = Number(formData['tokenrotator.rotationUpdateFrequency']);
    await this._updateSettings(map);
  }
}

export function registerSpaceholderSettingsMenus() {
  // Two submenus under system settings
  game.settings.registerMenu(MODULE_NS, 'tokenpointer-menu', {
    name: 'Token Pointer', label: 'Configure', hint: 'Configure Token Pointer settings',
    type: TokenPointerSettingsApp, restricted: true,
  });
  game.settings.registerMenu(MODULE_NS, 'tokenrotator-menu', {
    name: 'Token Rotator', label: 'Configure', hint: 'Configure Token Rotator settings',
    type: TokenRotatorSettingsApp, restricted: false,
  });
}
