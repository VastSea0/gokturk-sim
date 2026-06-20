const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    console.log('Navigating to http://localhost:5173...');
    await page.goto('http://localhost:5173');
    await page.waitForTimeout(3000);

    const info = await page.evaluate(() => {
      const hud = document.getElementById('hud');
      if (!hud) return 'No #hud found';
      
      const computed = window.getComputedStyle(hud);
      return {
        display: computed.display,
        width: computed.width,
        height: computed.height,
        gridTemplateColumns: computed.gridTemplateColumns,
        gridTemplateRows: computed.gridTemplateRows,
        gridAutoRows: computed.gridAutoRows,
        gridAutoFlow: computed.gridAutoFlow,
        alignContent: computed.alignContent,
        justifyContent: computed.justifyContent,
        alignItems: computed.alignItems,
        justifyItems: computed.justifyItems
      };
    });

    console.log('--- HUD GRID DETAIL ---');
    console.log(JSON.stringify(info, null, 2));
    console.log('------------------------');

  } catch (error) {
    console.error('Inspection error:', error);
  } finally {
    await browser.close();
  }
})();
