package main

import "fmt"

type Greeter interface {
	Hello() string
}

type GoTest struct{}

func (g GoTest) Hello() string {
	return "world"
}

func main() {
	var g Greeter = GoTest{}
	fmt.Println(g.Hello())
}
