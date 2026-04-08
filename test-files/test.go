package main

import "fmt"

func Hello() string {
	return 123 // Error: cannot use int as string
}

func main() {
	fmt.Println(Hello("too many")) // Error: too many arguments
}
