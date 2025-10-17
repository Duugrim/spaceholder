// PayloadFactory - фабрика для создания стандартных payload
// Создает готовые конфигурации для различных типов оружия

/**
 * Фабрика для создания payload различных типов оружия
 */
export class PayloadFactory {
  
  /**
   * Простой пистолет - одна прямая линия
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для пистолета
   */
  static createPistol(options = {}) {
    const {
      range = 300,
      damage = { direct: 15 },
      allowRicochet = false,
      maxRicochets = 0
    } = options;
    
    return {
      name: 'pistol',
      trajectory: [
        {
          type: 'line',
          length: range,
          damage: damage,
          effects: {
            onHit: ['bullet_impact'],
            onMiss: null
          },
          allowRicochet: allowRicochet,
          maxRicochets: maxRicochets
        }
      ]
    };
  }
  
  /**
   * Винтовка - длинная прямая линия с высоким уроном
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для винтовки
   */
  static createRifle(options = {}) {
    const {
      range = 800,
      damage = { direct: 35 },
      allowRicochet = false,
      maxRicochets = 1
    } = options;
    
    return {
      name: 'rifle',
      trajectory: [
        {
          type: 'line',
          length: range,
          damage: damage,
          effects: {
            onHit: ['heavy_bullet_impact'],
            onMiss: null,
            onRicochet: ['bullet_ricochet']
          },
          allowRicochet: allowRicochet,
          maxRicochets: maxRicochets
        }
      ]
    };
  }
  
  /**
   * Дробовик - несколько коротких линий в разных направлениях
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для дробовика
   */
  static createShotgun(options = {}) {
    const {
      range = 200,
      pellets = 5,
      spread = 30, // общий разброс в градусах
      damage = { direct: 8 },
      allowRicochet = false
    } = options;
    
    // Создаем основной снаряд с разделением на дробь
    const children = [];
    const angleStep = spread / (pellets - 1);
    const startAngle = -spread / 2;
    
    for (let i = 0; i < pellets; i++) {
      const offsetAngle = startAngle + (i * angleStep);
      children.push({
        type: 'line',
        length: range,
        offsetAngle: offsetAngle,
        damage: damage,
        effects: {
          onHit: ['pellet_impact'],
          onMiss: null
        },
        allowRicochet: allowRicochet,
        maxRicochets: 0
      });
    }
    
    return {
      name: 'shotgun',
      trajectory: [
        {
          type: 'line',
          length: 50, // короткий основной сегмент перед разделением
          damage: { direct: 1 }, // минимальный урон основного снаряда
          effects: {
            onHit: ['shotgun_muzzle_flash'],
            onMiss: null
          },
          allowRicochet: false,
          children: children
        }
      ]
    };
  }
  
  /**
   * Гранатомет - летит прямо, взрывается при столкновении
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для гранатомета
   */
  static createGrenadeLauncher(options = {}) {
    const {
      range = 400,
      directDamage = { direct: 25 },
      explosionDamage = { area: 50 },
      allowRicochet = false
    } = options;
    
    return {
      name: 'grenade_launcher',
      trajectory: [
        {
          type: 'line',
          length: range,
          damage: directDamage,
          effects: {
            onHit: ['grenade_direct_hit'],
            onMiss: null
          },
          allowRicochet: allowRicochet
        },
        {
          type: 'lineRec',
          length: 1, // практически мгновенный взрыв
          maxIterations: 1,
          damage: explosionDamage,
          effects: {
            onCollision: ['grenade_explosion'],
            onMiss: ['grenade_explosion'] // взрывается в любом случае
          },
          allowRicochet: false
        }
      ]
    };
  }
  
  /**
   * Лазерное оружие - мгновенная линия с эффектами
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для лазера
   */
  static createLaser(options = {}) {
    const {
      range = 600,
      damage = { direct: 20, thermal: 10 },
      allowRicochet = false,
      maxRicochets = 2
    } = options;
    
    return {
      name: 'laser',
      trajectory: [
        {
          type: 'line',
          length: range,
          damage: damage,
          effects: {
            onHit: ['laser_burn'],
            onMiss: null,
            onRicochet: ['laser_reflection']
          },
          allowRicochet: allowRicochet,
          maxRicochets: maxRicochets
        }
      ]
    };
  }
  
  /**
   * Кластерная боеголовка - летит прямо, потом разделяется на множество мелких
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для кластерной боеголовки
   */
  static createClusterMunition(options = {}) {
    const {
      range = 300,
      submunitions = 8,
      spread = 60,
      mainDamage = { direct: 10 },
      subDamage = { direct: 15, area: 25 }
    } = options;
    
    // Создаем суббоеприпасы
    const children = [];
    const angleStep = spread / submunitions;
    const startAngle = -spread / 2;
    
    for (let i = 0; i < submunitions; i++) {
      const offsetAngle = startAngle + (i * angleStep);
      children.push({
        type: 'lineRec',
        length: 80,
        maxIterations: 5,
        offsetAngle: offsetAngle,
        damage: subDamage,
        effects: {
          onCollision: ['submunition_explosion'],
          onMiss: ['submunition_explosion']
        },
        allowRicochet: false
      });
    }
    
    return {
      name: 'cluster_munition',
      trajectory: [
        {
          type: 'line',
          length: range,
          damage: mainDamage,
          effects: {
            onHit: ['cluster_direct_hit'],
            onMiss: null
          },
          allowRicochet: false,
          children: children
        }
      ]
    };
  }
  
  /**
   * Получить список всех доступных типов оружия
   * @returns {Array} массив названий типов оружия
   */
  static getAvailableWeaponTypes() {
    return [
      'pistol',
      'rifle', 
      'shotgun',
      'grenade_launcher',
      'laser',
      'cluster_munition'
    ];
  }
  
  /**
   * Создать payload по названию типа
   * @param {string} weaponType - тип оружия
   * @param {Object} options - параметры настройки
   * @returns {Object} payload для указанного типа оружия
   */
  static create(weaponType, options = {}) {
    switch (weaponType) {
      case 'pistol':
        return this.createPistol(options);
      case 'rifle':
        return this.createRifle(options);
      case 'shotgun':
        return this.createShotgun(options);
      case 'grenade_launcher':
        return this.createGrenadeLauncher(options);
      case 'laser':
        return this.createLaser(options);
      case 'cluster_munition':
        return this.createClusterMunition(options);
      default:
        throw new Error(`Unknown weapon type: ${weaponType}`);
    }
  }
  
  /**
   * Получить описание типа оружия
   * @param {string} weaponType - тип оружия
   * @returns {Object} описание оружия
   */
  static getWeaponDescription(weaponType) {
    const descriptions = {
      pistol: {
        name: 'Пистолет',
        description: 'Простое оружие ближнего боя с одной прямой траекторией',
        range: 'Короткая',
        complexity: 'Простая'
      },
      rifle: {
        name: 'Винтовка',
        description: 'Дальнобойное оружие с высокой точностью и уроном',
        range: 'Длинная',
        complexity: 'Простая'
      },
      shotgun: {
        name: 'Дробовик',
        description: 'Разделяется на несколько дробинок с широким разбросом',
        range: 'Короткая',
        complexity: 'Средняя (разделение)'
      },
      grenade_launcher: {
        name: 'Гранатомет',
        description: 'Двухэтапное оружие: полет снаряда + взрыв при столкновении',
        range: 'Средняя',
        complexity: 'Средняя (взрывчатка)'
      },
      laser: {
        name: 'Лазер',
        description: 'Энергетическое оружие с возможностью отражения',
        range: 'Длинная',
        complexity: 'Средняя (отражения)'
      },
      cluster_munition: {
        name: 'Кластерная боеголовка',
        description: 'Сложное оружие: основной снаряд + множество суббоеприпасов',
        range: 'Средняя',
        complexity: 'Высокая (множественное разделение)'
      }
    };
    
    return descriptions[weaponType] || { name: 'Неизвестно', description: 'Неизвестный тип оружия' };
  }
}