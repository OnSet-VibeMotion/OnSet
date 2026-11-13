/**
 * 全部内置插件的登记处（进程内 apply）。新增一个内置功能：在 plugins/<id>/ 写它的 apply，在这里加一行登记，
 * 在 assets/plugins/<id>/am-station.json 写清单（开关、名字、说明）。宿主的 flow、scene、progress、projectinit、
 * 工具服务都不用改。
 *
 * 由 plugin 包的入口导入（登记靠这里的副作用，集中在一处才不会漏）。插件排队，第一次取登记表时才 apply
 * （见 registry.ts 的 deferBuiltin）。登记顺序就是镜头提示词里插件技能段的先后。
 */
import { deferBuiltin } from '../plugin/registry';
import { algorithmicArt } from './algorithmic-art';
import { castPlugin } from './cast';
import { publishing } from './publishing';
import { songPlugin } from './song';
import { textToLottie } from './text-to-lottie';

deferBuiltin(publishing);
deferBuiltin(songPlugin);
deferBuiltin(algorithmicArt);
deferBuiltin(textToLottie);
deferBuiltin(castPlugin);
