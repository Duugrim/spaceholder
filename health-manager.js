// Универсальный менеджер здоровья и анатомии с диалоговым интерфейсом
// Скопируйте и выполните в консоли браузера FoundryVTT

(function() {
    console.log("=== HEALTH & ANATOMY MANAGER ===");
    
    // Проверяем доступность anatomyManager
    const anatomyManager = window.anatomyManager || game.spaceholder?.anatomyManager;
    
    if (!anatomyManager) {
        console.warn("anatomyManager не найден, ищем альтернативный способ...");
        
        // Попытка найти anatomyManager в модулях системы
        try {
            const systemModule = game.system.modules?.get('spaceholder');
            if (systemModule) {
                // anatomyManager может быть в разных местах
                window.anatomyManager = systemModule.anatomyManager;
            }
        } catch (e) {
            console.warn("Не удалось найти anatomyManager через модули");
        }
    }
    
    // Функции-заглушки для работы с анатомией если anatomyManager недоступен
    const safeAnatomyManager = {
        getAvailableAnatomies: () => {
            return {
                'humanoid': { name: 'Humanoid' },
                'quadruped': { name: 'Quadruped' }
            };
        },
        getAnatomyDisplayName: (id) => {
            const names = {
                'humanoid': 'Гуманоид',
                'quadruped': 'Четвероногий'
            };
            return names[id] || id;
        }
    };
    
    const manager = anatomyManager || safeAnatomyManager;
    
    // Находим актера: выбранный токен или персонажа с именем "Character"
    function findActor() {
        // Сначала проверяем выбранные токены
        const selectedTokens = canvas.tokens.controlled;
        if (selectedTokens.length > 0) {
            return selectedTokens[0].actor;
        }
        
        // Если нет выбранного токена, ищем персонажа "Character"
        const characterActor = game.actors.find(a => a.name === "Character" && a.type === "character");
        if (characterActor) {
            return characterActor;
        }
        
        // В крайнем случае берем персонажа пользователя
        return game.user.character;
    }
    
    const actor = findActor();
    
    if (!actor) {
        ui.notifications.error("Не найден подходящий персонаж! Выберите токен или создайте персонажа с именем 'Character'.");
        return;
    }
    
    console.log(`Выбран актер: ${actor.name} (${actor.type})`);
    
    // Функции управления здоровьем
    async function dealDamage(damage) {
        if (typeof actor.performHit !== 'function') {
            ui.notifications.warn('Функция нанесения урона недоступна для данного актера');
            return null;
        }
        
        const result = await actor.performHit(damage);
        if (result) {
            ui.notifications.info(`Попадание в ${result.bodyPart.name} на ${damage} урона`);
            if (actor.sheet?.rendered) {
                actor.sheet.render(false);
            }
        }
        return result;
    }
    
    async function healCompletely() {
        const bodyParts = actor.system.anatomy?.bodyParts || actor.system.health?.bodyParts;
        if (!bodyParts) {
            ui.notifications.warn("Нет частей тела для исцеления");
            return;
        }
        
        const updates = {};
        for (let [id, part] of Object.entries(bodyParts)) {
            const updatePath = actor.system.anatomy?.bodyParts 
                ? `system.anatomy.bodyParts.${id}.currentHp`
                : `system.health.bodyParts.${id}.currentHp`;
            updates[updatePath] = part.maxHp;
        }
        
        await actor.update(updates);
        ui.notifications.info("Персонаж полностью исцелен!");
        
        if (actor.sheet?.rendered) {
            actor.sheet.render(false);
        }
    }
    
    function showHealthStatus() {
        const totalHealth = actor.system.health?.totalHealth;
        const bodyParts = actor.system.anatomy?.bodyParts || actor.system.health?.bodyParts;
        
        let statusHTML = `
            <div style="font-family: monospace;">
                <h3>Здоровье персонажа: ${actor.name}</h3>
                <p><strong>Общее здоровье:</strong> ${totalHealth?.current || 0}/${totalHealth?.max || 0} (${totalHealth?.percentage || 100}%)</p>
                <h4>Части тела:</h4>
                <div style="max-height: 300px; overflow-y: auto;">
        `;
        
        if (bodyParts) {
            for (let [partId, part] of Object.entries(bodyParts)) {
                const percentage = Math.floor((part.currentHp / part.maxHp) * 100);
                const status = percentage === 100 ? "здоров" : 
                              percentage >= 75 ? "легкие повреждения" :
                              percentage >= 50 ? "травмирован" :
                              percentage >= 25 ? "сильно травмирован" :
                              percentage > 0 ? "критическое состояние" : "уничтожен";
                
                const color = percentage === 100 ? "#28a745" : 
                             percentage >= 75 ? "#ffc107" :
                             percentage >= 50 ? "#fd7e14" :
                             percentage >= 25 ? "#dc3545" :
                             percentage > 0 ? "#6f42c1" : "#343a40";
                
                statusHTML += `
                    <p style="margin: 2px 0;">
                        <span style="color: ${color}; font-weight: bold;">${part.name}:</span> 
                        ${part.currentHp}/${part.maxHp} HP (${status})
                    </p>
                `;
            }
        } else {
            statusHTML += '<p><em>Нет данных о частях тела</em></p>';
        }
        
        statusHTML += '</div></div>';
        
        new Dialog({
            title: "Состояние здоровья",
            content: statusHTML,
            buttons: {
                ok: {
                    icon: '<i class="fas fa-check"></i>',
                    label: "OK"
                }
            },
            default: "ok"
        }, {
            width: 400,
            height: 500,
            resizable: true
        }).render(true);
    }
    
    async function changeAnatomy() {
        // Проверяем, доступен ли метод смены анатомии
        if (typeof actor.changeAnatomyType !== 'function') {
            ui.notifications.warn('Функция смены анатомии недоступна для данного актера');
            return;
        }
        
        const availableAnatomies = manager.getAvailableAnatomies();
        const currentType = actor.system.anatomy?.type;
        
        let optionsHTML = '';
        for (let [id, anatomy] of Object.entries(availableAnatomies)) {
            const selected = id === currentType ? 'selected' : '';
            const displayName = manager.getAnatomyDisplayName(id);
            optionsHTML += `<option value="${id}" ${selected}>${displayName}</option>`;
        }
        
        const content = `
            <div>
                <p><strong>Текущая анатомия:</strong> ${currentType ? manager.getAnatomyDisplayName(currentType) : 'Не выбрана'}</p>
                <div class="form-group">
                    <label>Выберите новый тип анатомии:</label>
                    <select id="anatomy-select" style="width: 100%; padding: 8px; margin: 10px 0; height: 40px; font-size: 14px;">
                        ${optionsHTML}
                    </select>
                </div>
                ${currentType ? 
                    '<p style="color: #dc3545;"><i class="fas fa-exclamation-triangle"></i> <strong>Внимание:</strong> Это заменит все текущие части тела и сбросит значения здоровья.</p>' : 
                    '<p style="color: #17a2b8;"><i class="fas fa-info-circle"></i> Это инициализирует систему анатомии для персонажа.</p>'
                }
            </div>
        `;
        
        new Dialog({
            title: "Смена типа анатомии",
            content: content,
            buttons: {
                change: {
                    icon: '<i class="fas fa-exchange-alt"></i>',
                    label: "Изменить",
                    callback: async (html) => {
                        const selectedType = html.find('#anatomy-select').val();
                        if (selectedType && selectedType !== currentType) {
                            const success = await actor.changeAnatomyType(selectedType);
                            if (success) {
                                ui.notifications.info(`Анатомия изменена на ${manager.getAnatomyDisplayName(selectedType)}`);
                            }
                        }
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Отмена"
                }
            },
            default: "change"
        }, {
            width: 450
        }).render(true);
    }
    
    // Главное диалоговое окно
    function showMainDialog() {
        const totalHealth = actor.system.health?.totalHealth;
        const currentAnatomy = actor.system.anatomy?.type;
        
        const content = `
            <div style="text-align: center;">
                <h3>Управление здоровьем</h3>
                <p><strong>Персонаж:</strong> ${actor.name}</p>
                <p><strong>Анатомия:</strong> ${currentAnatomy ? manager.getAnatomyDisplayName(currentAnatomy) : 'Не выбрана'}</p>
                <p><strong>Здоровье:</strong> ${totalHealth?.current || 0}/${totalHealth?.max || 0} (${totalHealth?.percentage || 100}%)</p>
                <hr>
                <div class="form-group">
                    <label>Урон для нанесения:</label>
                    <input type="number" id="damage-amount" value="5" min="1" max="100" style="width: 100%; padding: 5px; margin: 5px 0;">
                </div>
            </div>
        `;
        
        new Dialog({
            title: "Health & Anatomy Manager",
            content: content,
            buttons: {
                damage: {
                    icon: '<i class="fas fa-heart-broken"></i>',
                    label: "Нанести урон",
                    callback: async (html) => {
                        const damage = parseInt(html.find('#damage-amount').val()) || 5;
                        await dealDamage(damage);
                        // Показываем диалог снова после небольшой задержки
                        setTimeout(() => showMainDialog(), 500);
                    }
                },
                heal: {
                    icon: '<i class="fas fa-heart"></i>',
                    label: "Полное исцеление",
                    callback: async () => {
                        await healCompletely();
                        setTimeout(() => showMainDialog(), 500);
                    }
                },
                status: {
                    icon: '<i class="fas fa-heartbeat"></i>',
                    label: "Показать статус",
                    callback: () => {
                        showHealthStatus();
                        setTimeout(() => showMainDialog(), 100);
                    }
                },
                anatomy: {
                    icon: '<i class="fas fa-user-md"></i>',
                    label: "Сменить анатомию",
                    callback: () => {
                        changeAnatomy();
                        setTimeout(() => showMainDialog(), 100);
                    }
                },
                close: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Закрыть"
                }
            },
            default: "damage",
            render: (html) => {
                html.find('#damage-amount').focus().select();
            }
        }, {
            width: 400,
            resizable: true
        }).render(true);
    }
    
    // Глобальная функция для быстрого доступа
    window.healthManager = showMainDialog;
    
    // Запускаем главный диалог
    showMainDialog();
    
    console.log("✅ Health Manager загружен!");
    console.log("Для повторного вызова используйте: healthManager()");
    
})();