#include <stdio.h>

const char* hello() {
    return 123; // Warning/Error: returning int as pointer
}

int main() {
    printf("%s\n", hello(1)); // Error: too many arguments
    return 0;
}