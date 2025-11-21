/**
 * ⚠️ УСТАРЕВШИЙ КОД - НЕ ИСПОЛЬЗОВАТЬ ⚠️
 * 
 * Этот модуль является УСТАРЕВШИМ и больше НЕ используется в системе.
 * Код сохранён только для справки и примеров старой реализации.
 * 
 * ❌ НЕ дорабатывайте этот код
 * ❌ НЕ используйте его в новых функциях
 * ✅ Используйте только как справочный материал
 * 
 * @deprecated Используйте новые тесты вместо legacy
 * Дата архивации: 2025-10-28
 */

// Тестирование системы прицеливания SpaceHolder
// Простые тесты для проверки основного функционала

export class AimingSystemTester {
  constructor() {
    this.tests = [];
  }
  
  /**
   * Запустить все тесты
   */
  async runAllTests() {
    console.log('SpaceHolder | AimingSystemTester: Starting tests...');
    
    const results = {
      passed: 0,
      failed: 0,
      errors: []
    };
    
    // Тест 1: Проверка инициализации
    try {
      await this.testInitialization();
      results.passed++;
      console.log('✓ Test 1: Initialization - PASSED');
    } catch (error) {
      results.failed++;
      results.errors.push({ test: 'Initialization', error: error.message });
      console.error('✗ Test 1: Initialization - FAILED:', error.message);
    }
    
    // Тест 2: Создание луча
    try {
      await this.testRayCreation();
      results.passed++;
      console.log('✓ Test 2: Ray Creation - PASSED');
    } catch (error) {
      results.failed++;
      results.errors.push({ test: 'Ray Creation', error: error.message });
      console.error('✗ Test 2: Ray Creation - FAILED:', error.message);
    }
    
    // Тест 3: Визуализация
    try {
      await this.testVisualization();
      results.passed++;
      console.log('✓ Test 3: Visualization - PASSED');
    } catch (error) {
      results.failed++;
      results.errors.push({ test: 'Visualization', error: error.message });
      console.error('✗ Test 3: Visualization - FAILED:', error.message);
    }
    
    console.log(`SpaceHolder | AimingSystemTester: Tests completed. Passed: ${results.passed}, Failed: ${results.failed}`);
    return results;
  }
  
  /**
   * Тест инициализации системы
   */
  async testInitialization() {
    if (!game.spaceholder?.aimingSystem) {
      throw new Error('AimingSystem not found in game.spaceholder');
    }
    
    const aimingSystem = game.spaceholder.aimingSystem;
    
    // Проверяем, что компоненты инициализированы
    if (!aimingSystem.rayCaster) {
      throw new Error('RayCaster not initialized');
    }
    
    if (!aimingSystem.rayRenderer) {
      throw new Error('RayRenderer not initialized');
    }
    
    // Проверяем начальное состояние
    if (aimingSystem.isAiming !== false) {
      throw new Error('Initial aiming state should be false');
    }
    
    if (aimingSystem.aimingToken !== null) {
      throw new Error('Initial aiming token should be null');
    }
  }
  
  /**
   * Тест создания луча
   */
  async testRayCreation() {
    const aimingSystem = game.spaceholder.aimingSystem;
    const rayCaster = aimingSystem.rayCaster;
    
    // Создаем тестовый луч
    const origin = { x: 100, y: 100 };
    const direction = 45; // 45 градусов
    const maxDistance = 500;
    
    const ray = rayCaster.createRay(origin, direction, maxDistance);
    
    // Проверяем свойства луча
    if (!ray.id) {
      throw new Error('Ray should have an ID');
    }
    
    if (ray.origin.x !== origin.x || ray.origin.y !== origin.y) {
      throw new Error('Ray origin mismatch');
    }
    
    if (ray.direction !== direction) {
      throw new Error('Ray direction mismatch');
    }
    
    if (ray.maxDistance !== maxDistance) {
      throw new Error('Ray max distance mismatch');
    }
    
    if (!ray.segments || ray.segments.length === 0) {
      throw new Error('Ray should have segments');
    }
    
    // Проверяем правильность вычисления конечной точки
    const expectedEndX = origin.x + Math.cos(direction * Math.PI / 180) * maxDistance;
    const expectedEndY = origin.y + Math.sin(direction * Math.PI / 180) * maxDistance;
    
    const tolerance = 0.1;
    if (Math.abs(ray.end.x - expectedEndX) > tolerance || Math.abs(ray.end.y - expectedEndY) > tolerance) {
      throw new Error('Ray end point calculation error');
    }
  }
  
  /**
   * Тест визуализации
   */
  async testVisualization() {
    const aimingSystem = game.spaceholder.aimingSystem;
    const rayRenderer = aimingSystem.rayRenderer;
    
    // Проверяем, что canvas доступен
    if (!canvas?.stage) {
      throw new Error('Canvas not available for visualization test');
    }
    
    // Проверяем создание контейнеров
    rayRenderer._createContainers();
    
    if (!rayRenderer.aimingContainer) {
      throw new Error('Aiming container not created');
    }
    
    if (!rayRenderer.rayContainer) {
      throw new Error('Ray container not created');
    }
    
    if (!rayRenderer.reticleContainer) {
      throw new Error('Reticle container not created');
    }
    
    // Создаем тестовый луч и проверяем его отрисовку
    const testRay = aimingSystem.rayCaster.createRay({ x: 100, y: 100 }, 0, 200);
    
    // Обновляем предпросмотр (не должно вызывать ошибок)
    rayRenderer.updateAimingPreview(testRay);
    
    // Очищаем тестовые элементы
    rayRenderer.clearAll();
  }
  
  /**
   * Интерактивный тест с токеном (если токен выбран)
   */
  async testWithSelectedToken() {
    const controlled = canvas.tokens.controlled;
    
    if (controlled.length === 0) {
      ui.notifications.warn('Выберите токен для интерактивного тестирования');
      return false;
    }
    
    const token = controlled[0];
    const aimingSystem = game.spaceholder.aimingSystem;
    
    ui.notifications.info('Запуск 5-секундного теста прицеливания...');
    
    // Запускаем прицеливание
    const success = aimingSystem.startAiming(token);
    
    if (!success) {
      throw new Error('Failed to start aiming');
    }
    
    // Автоматически завершаем через 5 секунд
    setTimeout(() => {
      if (aimingSystem.isAiming) {
        aimingSystem.stopAiming();
        ui.notifications.info('Тест прицеливания завершен');
      }
    }, 5000);
    
    return true;
  }
}

// Глобальная функция для быстрого тестирования
window.testAimingSystem = async function() {
  const tester = new AimingSystemTester();
  const results = await tester.runAllTests();
  
  // Показываем результаты в чате
  const content = `
    <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
      <h3 style="color: #333; margin: 0;">🎯 Результаты тестирования системы прицеливания</h3>
      <p><strong>Пройдено:</strong> ${results.passed}</p>
      <p><strong>Провалено:</strong> ${results.failed}</p>
      ${results.errors.length > 0 ? `
        <details>
          <summary>Ошибки:</summary>
          <ul>
            ${results.errors.map(e => `<li><strong>${e.test}:</strong> ${e.error}</li>`).join('')}
          </ul>
        </details>
      ` : ''}
    </div>
  `;
  
  ChatMessage.create({
    content: content,
    speaker: { alias: "Система тестирования" }
  });
  
  return results;
};

// Интерактивный тест с выбранным токеном
window.testAimingWithToken = async function() {
  const tester = new AimingSystemTester();
  try {
    await tester.testWithSelectedToken();
  } catch (error) {
    ui.notifications.error('Ошибка интерактивного теста: ' + error.message);
    console.error(error);
  }
};