// Тестовый скрипт для проверки работы draw-manager
// Создаёт тестовые данные и вызывает отрисовку

/**
 * Тестирование draw-manager с простыми данными
 */
function testDrawManager() {
  console.log('🎨 Starting draw-manager test...');
  
  // Проверяем что draw-manager инициализирован
  if (!game.spaceholder?.drawManager) {
    console.error('❌ DrawManager not found! Make sure the system is loaded.');
    ui.notifications.error('DrawManager не найден! Убедитесь что система загружена.');
    return;
  }
  
  // Создаём тестовые данные согласно структуре из draw-input-example.md
  const testShotResult = {
    shotPaths: [
      {
        id: 0,
        type: "line",
        start: { x: 100, y: 300 },
        end: { x: 150, y: 290 }
      },
      {
        id: 1,
        type: "line", 
        start: { x: 150, y: 290 },
        end: { x: 200, y: 270 }
      },
      {
        id: 2,
        type: "line",
        start: { x: 200, y: 270 },
        end: { x: 250, y: 240 }
      },
      {
        id: 3,
        type: "circle",
        range: 50,
        start: { x: 250, y: 240 },
        end: { x: 250, y: 240 }
      }
    ],
    shotHits: [
      // Игнорируем shotHits для этого теста, как указано в задании
    ]
  };
  
  console.log('🎯 Test data created:', testShotResult);
  
  try {
    // Вызываем отрисовку
    game.spaceholder.drawManager.drawShot(testShotResult);
    console.log('✅ DrawManager.drawShot() called successfully!');
    ui.notifications.info('Тест draw-manager выполнен успешно! Проверьте canvas для визуализации.');
  } catch (error) {
    console.error('❌ Error calling drawShot:', error);
    ui.notifications.error(`Ошибка при вызове drawShot: ${error.message}`);
  }
}

/**
 * Тестирование с более сложными данными
 */
function testDrawManagerAdvanced() {
  console.log('🎨 Starting advanced draw-manager test...');
  
  if (!game.spaceholder?.drawManager) {
    console.error('❌ DrawManager not found!');
    return;
  }
  
  // Более сложный тест с несколькими кругами и линиями
  const advancedShotResult = {
    shotPaths: [
      // Начальная линия
      {
        id: 0,
        type: "line",
        start: { x: 300, y: 400 },
        end: { x: 400, y: 350 }
      },
      // Первый круг
      {
        id: 1,
        type: "circle",
        range: 30,
        start: { x: 400, y: 350 },
        end: { x: 400, y: 350 }
      },
      // Продолжающая линия
      {
        id: 2,
        type: "line",
        start: { x: 400, y: 350 },
        end: { x: 500, y: 300 }
      },
      // Финальный большой круг
      {
        id: 3,
        type: "circle",
        range: 80,
        start: { x: 500, y: 300 },
        end: { x: 500, y: 300 }
      }
    ]
  };
  
  try {
    game.spaceholder.drawManager.drawShot(advancedShotResult);
    console.log('✅ Advanced DrawManager test completed!');
    ui.notifications.info('Продвинутый тест draw-manager выполнен!');
  } catch (error) {
    console.error('❌ Advanced test error:', error);
    ui.notifications.error(`Ошибка продвинутого теста: ${error.message}`);
  }
}

/**
 * Очистка всех нарисованных элементов
 */
function clearDrawManager() {
  console.log('🧹 Clearing draw-manager...');
  
  if (!game.spaceholder?.drawManager) {
    console.error('❌ DrawManager not found!');
    return;
  }
  
  try {
    game.spaceholder.drawManager.clearAll();
    console.log('✅ DrawManager cleared successfully!');
    ui.notifications.info('Draw-manager очищен!');
  } catch (error) {
    console.error('❌ Error clearing DrawManager:', error);
    ui.notifications.error(`Ошибка очистки: ${error.message}`);
  }
}

/**
 * Тест с пользовательскими стилями
 */
function testDrawManagerCustomStyles() {
  console.log('🎨 Testing draw-manager with custom styles...');
  
  if (!game.spaceholder?.drawManager) {
    console.error('❌ DrawManager not found!');
    return;
  }
  
  // Устанавливаем пользовательские стили
  const customStyles = {
    line: {
      color: 0x00FF00,  // Зелёный
      alpha: 0.8,
      width: 6
    },
    circle: {
      color: 0x0088FF,  // Синий
      alpha: 0.7,
      lineWidth: 4,
      fillAlpha: 0.3
    }
  };
  
  game.spaceholder.drawManager.setStyles(customStyles);
  
  const styledShotResult = {
    shotPaths: [
      {
        id: 0,
        type: "line",
        start: { x: 600, y: 200 },
        end: { x: 700, y: 180 }
      },
      {
        id: 1,
        type: "circle",
        range: 60,
        start: { x: 700, y: 180 },
        end: { x: 700, y: 180 }
      }
    ]
  };
  
  try {
    game.spaceholder.drawManager.drawShot(styledShotResult);
    console.log('✅ Custom styles test completed!');
    ui.notifications.info('Тест с пользовательскими стилями выполнен!');
  } catch (error) {
    console.error('❌ Custom styles test error:', error);
    ui.notifications.error(`Ошибка теста стилей: ${error.message}`);
  }
}

// Экспортируем функции для использования в консоли
window.testDrawManager = testDrawManager;
window.testDrawManagerAdvanced = testDrawManagerAdvanced;
window.testDrawManagerCustomStyles = testDrawManagerCustomStyles;
window.clearDrawManager = clearDrawManager;

// Автоматический запуск при загрузке (только в режиме разработки)
Hooks.once('ready', () => {
  if (game.settings.get('core', 'noCanvas')) return;
  
  console.log('🎨 Draw-manager test functions loaded!');
  console.log('📝 Available test functions:');
  console.log('  - testDrawManager() - простой тест');
  console.log('  - testDrawManagerAdvanced() - продвинутый тест');  
  console.log('  - testDrawManagerCustomStyles() - тест с пользовательскими стилями');
  console.log('  - clearDrawManager() - очистка');
  
  // Можно раскомментировать для автоматического запуска теста
  // setTimeout(() => {
  //   testDrawManager();
  // }, 2000);
});

export { testDrawManager, testDrawManagerAdvanced, testDrawManagerCustomStyles, clearDrawManager };