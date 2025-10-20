// PayloadFactory - фабрика для создания payload на основе траекторий
// Использует TrajectoryManager для загрузки готовых траекторий

import { trajectoryManager } from '../trajectory-manager.mjs';

/**
 * Фабрика для создания payload на основе готовых траекторий
 */
export class PayloadFactory {
  
  /**
   * Создать payload на основе траектории
   * @param {string} trajectoryId - ID траектории из TrajectoryManager
   * @param {Object} options - опции для кастомизации
   * @returns {Promise<Object>} готовый payload
   */
  static async create(trajectoryId, options = {}) {
    try {
      const payload = await trajectoryManager.createPayload(trajectoryId, options);
      return payload;
    } catch (error) {
      console.error(`PayloadFactory: Error creating payload for trajectory '${trajectoryId}':`, error);
      throw error;
    }
  }
  
  /**
   * Создать простой payload с прямой линией (устаревший)
   * @deprecated Используйте create('line_direct', options) вместо этого
   * @param {Object} options - опции
   * @returns {Promise<Object>} payload
   */
  static async createSimpleLine(options = {}) {
    console.warn('PayloadFactory.createSimpleLine is deprecated. Use create(\'line_direct\', options) instead.');
    return this.create('line_direct', options);
  }
  
  /**
   * Создать payload с рикошетом (устаревший)
   * @deprecated Используйте create('line_ricochet', options) вместо этого
   * @param {Object} options - опции
   * @returns {Promise<Object>} payload
   */
  static async createRicochetLine(options = {}) {
    console.warn('PayloadFactory.createRicochetLine is deprecated. Use create(\'line_ricochet\', options) instead.');
    return this.create('line_ricochet', options);
  }
  
  /**
   * Получить список всех доступных траекторий
   * @returns {Object} объект с доступными траекториями
   */
  static getAvailableTrajectories() {
    return trajectoryManager.getAvailableTrajectories();
  }
  
  /**
   * Получить траектории по категории
   * @param {string} category - категория
   * @returns {Object} объект с траекториями указанной категории
   */
  static getTrajectoriesByCategory(category) {
    return trajectoryManager.getTrajectoriesByCategory(category);
  }
  
  /**
   * Получить информацию о траектории
   * @param {string} trajectoryId - ID траектории
   * @returns {Object|null} информация о траектории
   */
  static getTrajectoryInfo(trajectoryId) {
    return trajectoryManager.getTrajectoryInfo(trajectoryId);
  }
  
  /**
   * Получить локализованное название траектории
   * @param {string} trajectoryId - ID траектории
   * @returns {string} локализованное название
   */
  static getTrajectoryDisplayName(trajectoryId) {
    return trajectoryManager.getTrajectoryDisplayName(trajectoryId);
  }
  
  /**
   * Получить статистику TrajectoryManager
   * @returns {Object} статистика
   */
  static getStats() {
    return trajectoryManager.getStats();
  }
}
