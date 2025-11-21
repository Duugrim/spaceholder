/**
 * ⚠️ LEGACY CODE - ОТКЛЮЧЕН ⚠️
 * Этот файл является устаревшей версией демо-макросов прицеливания.
 * Система переработана в новую модульную архитектуру.
 * Файл сохранён для справки, но не используется.
 * Дата архивации: 2025-10-28
 */

// Демонстрационные макросы для системы прицеливания SpaceHolder
// Эти функции добавляются в глобальный scope для удобного тестирования

/**
 * Начать прицеливание с выбранным токеном
 */
window.startAiming = function() {
  const controlled = canvas.tokens.controlled;
  
  if (controlled.length === 0) {
    ui.notifications.warn('Выберите токен для начала прицеливания');
    return false;
  }
  
  const token = controlled[0];
  const aimingSystem = game.spaceholder?.aimingSystem;
  
  if (!aimingSystem) {
    ui.notifications.error('Система прицеливания не инициализирована');
    return false;
  }
  
  const success = aimingSystem.startAiming(token);
  
  if (success) {
    ui.notifications.info(`Прицеливание активировано для ${token.name}`);
    console.log(`🎯 Aiming started for token: ${token.name} (ID: ${token.id})`);
  }
  
  return success;
};

/**
 * Остановить текущее прицеливание
 */
window.stopAiming = function() {
  const aimingSystem = game.spaceholder?.aimingSystem;
  
  if (!aimingSystem) {
    ui.notifications.error('Система прицеливания не инициализирована');
    return false;
  }
  
  if (!aimingSystem.isAiming) {
    ui.notifications.warn('Прицеливание не активно');
    return false;
  }
  
  aimingSystem.stopAiming();
  ui.notifications.info('Прицеливание остановлено');
  console.log('🛑 Aiming stopped');
  
  return true;
};

/**
 * Выстрелить в текущем направлении
 */
window.fireShot = function() {
  const aimingSystem = game.spaceholder?.aimingSystem;
  
  if (!aimingSystem) {
    ui.notifications.error('Система прицеливания не инициализирована');
    return false;
  }
  
  if (!aimingSystem.isAiming) {
    ui.notifications.warn('Прицеливание не активно');
    return false;
  }
  
  console.log('🔥 Manual fire triggered');
  aimingSystem.fire();
  
  return true;
};

/**
 * Получить информацию о текущем состоянии прицеливания
 */
window.getAimingInfo = function() {
  const aimingSystem = game.spaceholder?.aimingSystem;
  
  if (!aimingSystem) {
    console.error('Система прицеливания не инициализирована');
    return null;
  }
  
  const info = {
    isAiming: aimingSystem.isAiming,
    aimingToken: aimingSystem.aimingToken?.name || null,
    currentDirection: Math.round(aimingSystem.currentAimDirection),
    config: {
      maxRayDistance: aimingSystem.config.maxRayDistance,
      aimingSensitivity: aimingSystem.config.aimingSensitivity,
      showAimingReticle: aimingSystem.config.showAimingReticle,
    }
  };
  
  console.log('📊 Aiming System Status:', info);
  
  // Показываем в чате
  const content = `
    <div style="background: #f8f8f8; padding: 12px; border-radius: 6px; border-left: 4px solid #00aa00;">
      <h3 style="margin: 0 0 8px 0; color: #333;">🎯 Состояние системы прицеливания</h3>
      <p><strong>Активно:</strong> ${info.isAiming ? '✅ Да' : '❌ Нет'}</p>
      ${info.aimingToken ? `<p><strong>Токен:</strong> ${info.aimingToken}</p>` : ''}
      ${info.isAiming ? `<p><strong>Направление:</strong> ${info.currentDirection}°</p>` : ''}
      <details style="margin-top: 8px;">
        <summary style="cursor: pointer; color: #666;">⚙️ Настройки</summary>
        <ul style="margin: 4px 0 0 20px; font-size: 0.9em;">
          <li>Дальность луча: ${info.config.maxRayDistance}px</li>
          <li>Чувствительность: ${info.config.aimingSensitivity}</li>
          <li>Прицельная сетка: ${info.config.showAimingReticle ? 'Вкл' : 'Выкл'}</li>
        </ul>
      </details>
    </div>
  `;
  
  ChatMessage.create({
    content: content,
    speaker: { alias: "Система прицеливания" }
  });
  
  return info;
};

/**
 * Создать тестовую сцену с токенами и стенами
 */
window.createAimingTestScene = async function() {
  if (!game.user.isGM) {
    ui.notifications.error('Только GM может создать тестовую сцену');
    return false;
  }
  
  ui.notifications.info('Создание тестовой сцены для прицеливания...');
  
  try {
    // Создаем новую сцену
    const scene = await Scene.create({
      name: "Тест прицеливания",
      width: 2000,
      height: 1500,
      grid: {
        type: 1,
        size: 100
      },
      backgroundColor: "#999999"
    });
    
    // Активируем сцену
    await scene.activate();
    
    // Ждем готовности холста
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Создаем токены
    const tokens = [
      {
        name: "Стрелок",
        x: 300,
        y: 300,
        texture: {
          src: "icons/svg/mystery-man.svg"
        },
        width: 100,
        height: 100,
      },
      {
        name: "Цель 1",
        x: 800,
        y: 300,
        texture: {
          src: "icons/svg/target.svg"
        },
        width: 100,
        height: 100,
      },
      {
        name: "Цель 2",
        x: 1200,
        y: 600,
        texture: {
          src: "icons/svg/target.svg"
        },
        width: 100,
        height: 100,
      }
    ];
    
    await scene.createEmbeddedDocuments("Token", tokens);
    
    // Создаем стены
    const walls = [
      {
        c: [600, 200, 600, 800],
        move: 1,
        sight: 1
      },
      {
        c: [1000, 400, 1400, 400],
        move: 1,
        sight: 1
      }
    ];
    
    await scene.createEmbeddedDocuments("Wall", walls);
    
    ui.notifications.success('Тестовая сцена создана! Выберите "Стрелок" и используйте startAiming()');
    
    // Показываем инструкции в чате
    const instructions = `
      <div style="background: #e8f4f8; padding: 15px; border-radius: 8px;">
        <h3 style="margin: 0 0 10px 0; color: #2c5aa0;">🎯 Инструкции по тестированию</h3>
        <ol style="margin: 0; padding-left: 20px;">
          <li>Выберите токен "Стрелок"</li>
          <li>В консоли выполните: <code>startAiming()</code></li>
          <li>Поворачивайте мышь для прицеливания</li>
          <li>ЛКМ для выстрела или <code>fireShot()</code></li>
          <li>ПКМ или <code>stopAiming()</code> для отмены</li>
        </ol>
        <p style="margin: 10px 0 0 0; font-size: 0.9em; color: #666;">
          💡 Используйте <code>getAimingInfo()</code> для проверки состояния
        </p>
      </div>
    `;
    
    ChatMessage.create({
      content: instructions,
      speaker: { alias: "Система тестирования" }
    });
    
    return true;
    
  } catch (error) {
    console.error('Ошибка создания тестовой сцены:', error);
    ui.notifications.error('Ошибка создания тестовой сцены');
    return false;
  }
};

/**
 * Быстрый тест системы с выбранным токеном
 */
window.quickAimingTest = function() {
  const controlled = canvas.tokens.controlled;
  
  if (controlled.length === 0) {
    ui.notifications.warn('Выберите токен для тестирования');
    return false;
  }
  
  const token = controlled[0];
  const aimingSystem = game.spaceholder?.aimingSystem;
  
  if (!aimingSystem) {
    ui.notifications.error('Система прицеливания не инициализирована');
    return false;
  }
  
  // Начинаем прицеливание
  const success = aimingSystem.startAiming(token);
  
  if (!success) {
    ui.notifications.error('Не удалось начать прицеливание');
    return false;
  }
  
  ui.notifications.info('Быстрый тест: прицеливание на 3 секунды...');
  
  // Автоматически завершаем через 3 секунды
  setTimeout(() => {
    if (aimingSystem.isAiming) {
      aimingSystem.stopAiming();
      ui.notifications.success('Быстрый тест завершен');
    }
  }, 3000);
  
  return true;
};

/**
 * Протестировать алгоритм пересечения отрезков
 */
window.testWallIntersection = function() {
  const aimingSystem = game.spaceholder?.aimingSystem;
  
  if (!aimingSystem) {
    console.error('Система прицеливания не инициализирована');
    return;
  }
  
  const rayCaster = aimingSystem.rayCaster;
  
  // Тестовые случаи
  const tests = [
    {
      name: 'Прямое попадание',
      ray: { start: {x: 0, y: 0}, end: {x: 100, y: 0} },
      wall: { start: {x: 50, y: -10}, end: {x: 50, y: 10} },
      expected: true
    },
    {
      name: 'Промах мимо стены',
      ray: { start: {x: 0, y: 0}, end: {x: 100, y: 0} },
      wall: { start: {x: 50, y: 10}, end: {x: 50, y: 20} },
      expected: false
    },
    {
      name: 'Пересечение под углом',
      ray: { start: {x: 0, y: 0}, end: {x: 100, y: 100} },
      wall: { start: {x: 0, y: 50}, end: {x: 100, y: 50} },
      expected: true
    },
    {
      name: 'Луч не доходит до стены',
      ray: { start: {x: 0, y: 0}, end: {x: 30, y: 0} },
      wall: { start: {x: 50, y: -10}, end: {x: 50, y: 10} },
      expected: false
    }
  ];
  
  console.log('🧯 Тестирование пересечения со стенами:');
  
  let passed = 0;
  let failed = 0;
  
  tests.forEach((test, index) => {
    const intersection = rayCaster._raySegmentIntersection(
      test.ray.start, test.ray.end,
      test.wall.start, test.wall.end
    );
    
    const hasIntersection = intersection !== null;
    const success = hasIntersection === test.expected;
    
    console.log(`${index + 1}. ${test.name}: ${success ? '✅ Прошел' : '❌ Провал'}`);
    console.log(`   Ожидали: ${test.expected}, Получили: ${hasIntersection}`);
    
    if (intersection) {
      console.log(`   Точка пересечения: (${Math.round(intersection.x)}, ${Math.round(intersection.y)})`);
    }
    
    if (success) passed++;
    else failed++;
  });
  
  console.log(`📋 Итог: ${passed} прошло, ${failed} провалилось`);
  
  return { passed, failed };
};

// Регистрируем макросы в Foundry
Hooks.once('ready', () => {
  console.log('🎯 SpaceHolder Aiming Demo Macros loaded');
  console.log('Available commands:');
  console.log('  • startAiming() - начать прицеливание');
  console.log('  • stopAiming() - остановить прицеливание');
  console.log('  • fireShot() - выстрелить');
  console.log('  • getAimingInfo() - информация о состоянии');
  console.log('  • createAimingTestScene() - создать тестовую сцену (только GM)');
  console.log('  • quickAimingTest() - быстрый тест');
  console.log('  • testWallIntersection() - тест пересечения со стенами');
});
