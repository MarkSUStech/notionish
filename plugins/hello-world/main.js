/* Hello World Plugin */
(function () {
  "use strict";
  var PM = PluginManager;
  PM.on("pluginsLoaded", function () {
    console.log("[HelloWorld] Plugin loaded!");
    // 在侧栏底部添加文字
    var footer = document.querySelector(".sb-footer");
    if (footer) {
      var span = document.createElement("span");
      span.style.cssText = "font-size:10px;color:var(--text-faint);padding:4px 8px;flex:1;text-align:center";
      span.textContent = "插件已就绪";
      footer.appendChild(span);
    }
  });
  PM.exposeAPI("hello", { greet: function (n) { return "Hello, " + (n || "world") + "!"; } });
})();