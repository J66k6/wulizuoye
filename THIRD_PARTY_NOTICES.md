# 第三方代码说明

本项目以原生 HTML / CSS / JavaScript 编写，物理模型、Canvas 渲染、AI 教学引擎、
自适应测评与报告生成均为原创实现。运行时不依赖任何框架或 CDN 资源，唯一的
第三方代码是用于生成分享二维码的开源库：

## qrcode-generator 1.4.4

- 文件：`assets/js/vendor/qrcode.min.js`
- 用途：在「关于 / 帮助」弹窗中生成当前在线地址的二维码，方便手机扫码打开。
- 许可：MIT License
- 作者：Kazuhiko Arase
- 项目主页：https://github.com/kazuhikoarase/qrcode-generator

```
The MIT License (MIT)

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 字体与图标

- 页面不加载外部字体，使用系统字体栈（PingFang SC / Microsoft YaHei / system-ui）。
- 图标为内联 SVG，由本项目绘制；站点图标与分享图由 `tools/make-assets.py` 生成。
