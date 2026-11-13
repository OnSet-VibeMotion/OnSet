// Package prereq 是「前置资源」的共同约定。
//
// 要联网下载的东西（HyperFrames 技能与 CLI、lemo-opuscar 风格库）只由 am setup 准备，
// 由用户自己在终端里跑：网络慢时能看着进度、换代理、断了重来。其余命令（am init、
// am film-style use、am scene run、am hyperframes、Studio）只检查不下载，缺了就返回
// MissingError，统一指向 am setup。以前这些东西在渲染途中、建项目途中、打开菜单时
// 各自现下载，网络一差就卡在半路，用户还看不到卡在哪。
package prereq

import (
	"errors"
	"fmt"
)

// SetupCommand 是准备前置资源的命令。
const SetupCommand = "am setup"

// MissingError 表示某项前置资源还没准备好。
type MissingError struct {
	// What 是资源名，例如「HyperFrames CLI 0.8.225」。
	What string
	// Detail 补充说明（缺在哪里），可以为空。
	Detail string
}

func (e *MissingError) Error() string {
	detail := ""
	if e.Detail != "" {
		detail = "（" + e.Detail + "）"
	}
	return fmt.Sprintf("缺少前置资源：%s%s。先在终端运行 %s 准备好（可以加 --proxy 走代理，断了重跑会接着下），再重试", e.What, detail, SetupCommand)
}

// Missing 构造一个 MissingError。
func Missing(what, detail string) error {
	return &MissingError{What: what, Detail: detail}
}

// IsMissing 判断 err 是否（包着）MissingError。
func IsMissing(err error) bool {
	var missing *MissingError
	return errors.As(err, &missing)
}
